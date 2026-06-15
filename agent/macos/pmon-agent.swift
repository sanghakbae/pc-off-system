// PC 모니터링 macOS 에이전트
//
// 동작:
//   - 시작 시: power_on 이벤트 보고 (실제 부팅 시각 kern.boottime 포함)
//   - 화면 잠금 시: lock 이벤트 (com.apple.screenIsLocked)
//   - 화면 잠금해제 시: unlock 이벤트 (com.apple.screenIsUnlocked)
//   - 주기적으로: heartbeat (온라인 여부 판단용)
//   - 종료 시(로그아웃/재부팅 신호): shutdown 이벤트
//
// 실행: swift pmon-agent.swift   (또는 install.sh 로 launchd 등록)
// 설정: 환경변수 PMON_SERVER, PMON_TOKEN, PMON_INTERVAL 로 덮어쓰기 가능

import Foundation

// ── 설정 ───────────────────────────────────────────────────────────────
let env = ProcessInfo.processInfo.environment
let SERVER = env["PMON_SERVER"] ?? "http://127.0.0.1:4501"
let TOKEN  = env["PMON_TOKEN"]  ?? "change-me-pmon-token"     // ← config.js 의 token 과 일치
let INTERVAL = Double(env["PMON_INTERVAL"] ?? "30") ?? 30      // 하트비트 간격(초)

let hostname = ProcessInfo.processInfo.hostName
let username = NSUserName()
let osVersion = "macOS " + ProcessInfo.processInfo.operatingSystemVersionString

// 부팅 시각 (epoch ms)
func bootTimeMillis() -> Int64 {
    var tv = timeval()
    var size = MemoryLayout<timeval>.stride
    var mib = [CTL_KERN, KERN_BOOTTIME]
    if sysctl(&mib, 2, &tv, &size, nil, 0) == 0 {
        return Int64(tv.tv_sec) * 1000 + Int64(tv.tv_usec) / 1000
    }
    return Int64(Date().timeIntervalSince1970 * 1000)
}

func nowMillis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

// 외부 명령 실행 헬퍼
func runCmd(_ launch: String, _ args: [String]) -> String {
    let p = Process()
    p.launchPath = launch
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = Pipe()
    do { try p.run() } catch { return "" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
}

// 기본 라우트 인터페이스 → MAC / LAN IP
func primaryInterface() -> String {
    let out = runCmd("/sbin/route", ["-n", "get", "default"])
    for line in out.split(separator: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("interface:") { return t.replacingOccurrences(of: "interface:", with: "").trimmingCharacters(in: .whitespaces) }
    }
    return "en0"
}
func macAddress() -> String {
    let iface = primaryInterface()
    let out = runCmd("/sbin/ifconfig", [iface, "ether"])
    for line in out.split(separator: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("ether ") { return String(t.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
    }
    return ""
}
func localIp() -> String {
    return runCmd("/usr/sbin/ipconfig", ["getifaddr", primaryInterface()])
}
func vpnIp() -> String {
    let out = runCmd("/sbin/ifconfig", [])
    let pattern = #"^192\.168\.52\.([1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$"#
    for line in out.split(separator: "\n") {
        let parts = line.split(separator: " ")
        if parts.count >= 2 && parts[0] == "inet" {
            let ip = String(parts[1])
            if ip.range(of: pattern, options: .regularExpression) != nil { return ip }
        }
    }
    // 폴백: 실제 VPN 터널 인터페이스이고 그 IP가 VPN 대역일 때만 인정.
    // (LAN 머신에서도 route get 192.168.52.1 은 기본 인터페이스를 반환하므로 그대로 쓰면 LAN IP가 잡힌다)
    let iface = vpnInterface()
    if iface.hasPrefix("utun") || iface.hasPrefix("ppp") || iface.hasPrefix("ipsec") {
        let ip = interfaceIp(iface)
        if ip.range(of: pattern, options: .regularExpression) != nil { return ip }
    }
    return ""
}
func vpnInterface() -> String {
    let out = runCmd("/sbin/route", ["-n", "get", "192.168.52.1"])
    for line in out.split(separator: "\n") {
        let t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("interface:") { return t.replacingOccurrences(of: "interface:", with: "").trimmingCharacters(in: .whitespaces) }
    }
    return ""
}
func interfaceIp(_ iface: String) -> String {
    if iface.isEmpty { return "" }
    return runCmd("/usr/sbin/ipconfig", ["getifaddr", iface])
}
func vpnConnected(_ ip: String) -> Bool {
    if !ip.isEmpty { return true }
    let iface = vpnInterface()
    return iface.hasPrefix("utun") || iface.hasPrefix("ppp") || iface.hasPrefix("ipsec")
}
let macAddr = macAddress()
let lanIp = localIp()

func appExists(_ path: String) -> Bool {
    return FileManager.default.fileExists(atPath: path)
}

func processRunning(_ pattern: String) -> Bool {
    return !runCmd("/usr/bin/pgrep", ["-if", pattern]).isEmpty
}

func securityTools() -> [String: Any] {
    let v3Installed = appExists("/Applications/AhnLab V3 for Mac.app") || FileManager.default.fileExists(atPath: "/Library/Application Support/ahnlab/v3mac")
    let v3Running = processRunning("ahnlab/v3mac|com\\.ahnlab|v3svc|v3tray|v3fwd")
    let okInstalled = appExists("/Applications/OfficeKeeper.app")
    let okRunning = processRunning("OfficeKeeper|jkokmaind|jkokwatchd|jkokpolicyd|jkoklogd|com\\.jiran")
    return [
        "v3": ["installed": v3Installed, "running": v3Running],
        "officekeeper": ["installed": okInstalled, "running": okRunning],
    ]
}

func isScreenLocked() -> Bool {
    return runCmd("/usr/sbin/ioreg", ["-n", "Root", "-d1"]).contains("\"IOConsoleLocked\" = Yes")
}

// ── 서버 보고 ──────────────────────────────────────────────────────────
func report(_ type: String, ts: Int64? = nil) {
    guard let url = URL(string: SERVER + "/api/report") else { return }
    let currentVpnIp = vpnIp()
    var body: [String: Any] = [
        "hostname": hostname,
        "username": username,
        "os": osVersion,
        "boot_time": bootTimeMillis(),
        "type": type,
        "ts": ts ?? nowMillis(),
        "mac": macAddr,
        "local_ip": lanIp,
        "vpn_connected": vpnConnected(currentVpnIp),
        "vpn_ip": currentVpnIp,
        "security_tools": securityTools(),
    ]
    body["token"] = TOKEN
    guard let json = try? JSONSerialization.data(withJSONObject: body) else { return }

    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(TOKEN, forHTTPHeaderField: "X-Agent-Token")
    req.httpBody = json
    req.timeoutInterval = 10

    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { data, resp, err in
        if let err = err {
            FileHandle.standardError.write("report(\(type)) 실패: \(err.localizedDescription)\n".data(using: .utf8)!)
        } else if let http = resp as? HTTPURLResponse, http.statusCode != 200 {
            FileHandle.standardError.write("report(\(type)) HTTP \(http.statusCode)\n".data(using: .utf8)!)
        } else if
            let data = data,
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            obj["disabled"] as? Bool == true
        {
            print("report disabled: 수집 중지")
            exit(0)
        } else {
            print("report ok: \(type)")
        }
        sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 12)
}

// ── 잠금/해제 알림 구독 ────────────────────────────────────────────────
let dnc = DistributedNotificationCenter.default()
dnc.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in
    report("lock")
}
dnc.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in
    report("unlock")
}

// ── 종료 시그널 처리 (로그아웃/재부팅 시 launchd가 SIGTERM 전송) ──────────
let sigHandler: @convention(c) (Int32) -> Void = { _ in
    report("shutdown")
    exit(0)
}
signal(SIGTERM, sigHandler)
signal(SIGINT, sigHandler)

// ── 시작 보고 + 하트비트 타이머 ────────────────────────────────────────
print("pmon-agent 시작: host=\(hostname) user=\(username) server=\(SERVER)")
report("power_on")
if isScreenLocked() {
    report("lock")
}

let timer = Timer(timeInterval: INTERVAL, repeats: true) { _ in report("heartbeat") }
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
