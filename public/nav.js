const NAV_ITEMS = [
  {
    key: 'dashboard',
    href: '/?view=dashboard',
    title: '대시보드',
    subtitle: '통계 현황 요약',
    icon: 'grid',
  },
  {
    key: 'machines',
    href: '/?view=machines',
    title: 'PC 현황',
    subtitle: 'PC별 상태 및 이벤트',
    icon: 'monitor',
  },
  {
    key: 'report',
    href: '/report/',
    title: '감사 리포트',
    subtitle: '기간별 감사 리포트',
    icon: 'report',
  },
  {
    key: 'setup',
    href: '/setup/',
    title: '에이전트 설치',
    subtitle: '설치 안내 및 상태',
    icon: 'download',
  },
];

function currentNavKey() {
  const path = window.location.pathname;
  const view = new URLSearchParams(window.location.search).get('view');
  if (path === '/report' || path === '/report/') return 'report';
  if (path === '/setup' || path === '/setup/') return 'setup';
  if (view === 'machines') return 'machines';
  return 'dashboard';
}

function iconMarkup(icon) {
  const shapes = {
    grid: '<span></span><span></span><span></span><span></span>',
    monitor: '<span></span>',
    report: '<span></span><span></span><span></span>',
    download: '<span></span><span></span>',
  };
  return `<i class="app-nav-icon app-nav-icon-${icon}" aria-hidden="true">${shapes[icon] || ''}</i>`;
}

function renderAppNav() {
  if (document.querySelector('.app-sidebar')) return;
  document.body.classList.add('app-shell');
  if (localStorage.getItem('pcOffSidebarCollapsed') === '1') {
    document.body.classList.add('app-sidebar-collapsed');
  }
  const active = currentNavKey();
  const aside = document.createElement('aside');
  aside.className = 'app-sidebar';
  aside.setAttribute('aria-label', 'PC OFF 메뉴');
  aside.innerHTML = `
    <div class="app-sidebar-brand" aria-label="PC-OFF">
      <span class="brand-full">PC-OFF</span>
      <span class="brand-stack" aria-hidden="true"><span>PC</span><span>OFF</span></span>
    </div>
    <nav class="app-nav">
      ${NAV_ITEMS.map((item) => `
        <a class="app-nav-link${item.key === active ? ' active' : ''}" href="${item.href}" aria-current="${item.key === active ? 'page' : 'false'}">
          ${iconMarkup(item.icon)}
          <span>
            <strong>${item.title}</strong>
            <small>${item.subtitle}</small>
          </span>
        </a>
      `).join('')}
    </nav>
  `;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'app-nav-toggle';
  toggle.setAttribute('aria-label', document.body.classList.contains('app-sidebar-collapsed') ? '사이드 메뉴 펼치기' : '사이드 메뉴 접기');
  toggle.setAttribute('aria-expanded', document.body.classList.contains('app-sidebar-collapsed') ? 'false' : 'true');
  toggle.innerHTML = '<span></span><span></span>';
  document.body.prepend(aside);
  document.body.append(toggle);
  toggle.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('app-sidebar-collapsed');
    localStorage.setItem('pcOffSidebarCollapsed', collapsed ? '1' : '0');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', collapsed ? '사이드 메뉴 펼치기' : '사이드 메뉴 접기');
  });
}

renderAppNav();
