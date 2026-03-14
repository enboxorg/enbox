class NotificationDrawer extends HTMLElement {
  constructor() {
    super();
    this._onHashChange = this._onHashChange.bind(this);
  }

  connectedCallback() {
    this.render();
    window.addEventListener('hashchange', this._onHashChange);
    this._onHashChange();
  }

  disconnectedCallback() {
    window.removeEventListener('hashchange', this._onHashChange);
  }

  _onHashChange() {
    const hash = window.location.hash;
    if (hash !== '#notifications-drawer' && hash !== '#assistant-drawer') {
      return;
    }

    const drawer = this.querySelector('#notifications-drawer');
    if (!(drawer instanceof HTMLElement)) {
      return;
    }

    drawer.setAttribute('open', '');
  }

  render() {
    if (this.querySelector('#notifications-drawer')) {
      return;
    }

    this.innerHTML = `
      <wa-drawer id="notifications-drawer" light-dismiss>
        <div slot="label">
          <div class="wa-cluster">
            <wa-icon name="bell" variant="solid"></wa-icon>
            Notifications
          </div>
        </div>

        <div slot="header-actions" class="notifications-header-actions">
          <wa-badge appearance="filled" variant="success" pill>3 unread</wa-badge>
          <wa-button
            appearance="plain"
            size="small"
            class="notifications-close-button"
            data-drawer="close notifications-drawer"
            aria-label="Close notifications"
          >
            <wa-icon name="close" label="Close notifications"></wa-icon>
          </wa-button>
        </div>

        <div class="wa-stack notifications-list" role="list" aria-label="Notifications">
          <article class="notification-item is-unread">
            <div class="notification-layout">
              <wa-avatar
                class="notification-avatar"
                image="https://images.unsplash.com/photo-1614807547811-4174d3582092?q=80&w=2932&auto=format&fit=crop"
                label="Profile image for Happy"
              ></wa-avatar>
              <div class="wa-stack wa-gap-2xs notification-main">
                <div class="notification-topline">
                  <span class="notification-text"><strong>Happy</strong> commented in <a href="#">Reporting Dashboard</a></span>
                  <wa-icon class="notification-dot" name="circle" aria-hidden="true"></wa-icon>
                </div>
                <div class="notification-meta">
                  <span class="wa-caption-s">Today 3:12PM</span>
                  <wa-relative-time class="wa-caption-s" date="2026-03-12T15:12:00-05:00"></wa-relative-time>
                </div>
                <wa-callout variant="neutral" class="notification-message">
                  Really love this approach. I think this is the best solution for the sync issue.
                </wa-callout>
              </div>
            </div>
            <wa-divider></wa-divider>
          </article>

          <article class="notification-item is-unread">
            <div class="notification-layout">
              <wa-avatar
                class="notification-avatar"
                image="https://images.unsplash.com/photo-1613428800237-c86372070fab?q=80&w=3017&auto=format&fit=crop"
                label="Profile image for Charlotte"
              ></wa-avatar>
              <div class="wa-stack wa-gap-2xs notification-main">
                <div class="notification-topline">
                  <span class="notification-text"><strong>Charlotte</strong> followed you</span>
                  <wa-icon class="notification-dot" name="circle" aria-hidden="true"></wa-icon>
                </div>
                <div class="notification-meta">
                  <span class="wa-caption-s">Today 3:04PM</span>
                  <wa-relative-time class="wa-caption-s" date="2026-03-12T15:04:00-05:00"></wa-relative-time>
                </div>
              </div>
            </div>
            <wa-divider></wa-divider>
          </article>

          <article class="notification-item">
            <div class="notification-layout">
              <wa-avatar
                class="notification-avatar"
                image="https://images.unsplash.com/photo-1645288059073-af3e9eb62a29?q=80&w=2936&auto=format&fit=crop"
                label="Profile image for Tavitian"
              ></wa-avatar>
              <div class="wa-stack wa-gap-2xs notification-main">
                <div class="notification-topline">
                  <span class="notification-text"><strong>Tavitian</strong> invited you to <a href="#">Homepage Redesign</a></span>
                </div>
                <div class="notification-meta">
                  <span class="wa-caption-s">Today 2:22PM</span>
                  <wa-relative-time class="wa-caption-s" date="2026-03-12T14:22:00-05:00"></wa-relative-time>
                </div>
                <div class="wa-cluster wa-gap-xs notification-actions">
                  <wa-button appearance="outlined" size="small">Decline</wa-button>
                  <wa-button variant="brand" size="small">Accept</wa-button>
                </div>
              </div>
            </div>
            <wa-divider></wa-divider>
          </article>

          <article class="notification-item">
            <div class="notification-layout">
              <wa-avatar class="notification-avatar" initials="DW" label="DWeb system"></wa-avatar>
              <div class="wa-stack wa-gap-2xs notification-main">
                <div class="notification-topline">
                  <span class="notification-text"><strong>DWeb System</strong> detected elevated sync latency</span>
                </div>
                <div class="notification-meta">
                  <span class="wa-caption-s">Today 1:48PM</span>
                  <wa-relative-time class="wa-caption-s" date="2026-03-12T13:48:00-05:00"></wa-relative-time>
                </div>
                <wa-callout variant="warning" class="notification-message">
                  Records are still syncing. Performance should recover automatically.
                </wa-callout>
              </div>
            </div>
          </article>
        </div>

        <div slot="footer" class="wa-cluster wa-justify-content-between wa-gap-s notifications-footer">
          <wa-button appearance="plain" size="small">Notification Settings</wa-button>
          <wa-button variant="brand" appearance="outlined" size="small">Mark all as read</wa-button>
        </div>
      </wa-drawer>
    `;
  }
}

if (!customElements.get('notification-drawer')) {
  customElements.define('notification-drawer', NotificationDrawer);
}
