import { Router } from '@vaadin/router';

const routes = ['home', 'identity', 'data', 'apps', 'permissions', 'resolver'];

/** @typedef {'home' | 'identity' | 'data' | 'apps' | 'permissions' | 'resolver'} RouteId */

/** @typedef {{ [K in RouteId]: string }} RouteElementTagMap */

/** @type {RouteElementTagMap} */
const routeElementTags = {
  home        : 'home-page',
  identity    : 'identity-page',
  data        : 'data-page',
  apps        : 'apps-page',
  permissions : 'permissions-page',
  resolver    : 'resolver-page',
};

/**
 * @typedef RouterOptions
 * @property {(route: RouteId) => void=} onRouteActivated
 */

/**
 * @param {string} value
 * @returns {value is RouteId}
 */
function isRouteId(value) {
  return routes.includes(value);
}

/**
 * @param {RouteId} route
 * @returns {string}
 */
function routePath(route) {
  return `/${route}`;
}

/**
 * @param {RouterOptions=} options
 */
export function createRouter(options = {}) {
  const navButtons = Array.from(document.querySelectorAll('wa-button[data-route]'));

  const pageView = document.getElementById('page-view');
  if (!(pageView instanceof HTMLElement)) {
    throw new Error('Missing #page-view container');
  }

  const pageTabs = document.getElementById('page-tabs');
  if (!(pageTabs instanceof HTMLElement)) {
    throw new Error('Missing #page-tabs tab group');
  }

  /** @type {Map<RouteId, HTMLElement>} */
  const routeShells = new Map();
  /** @type {Map<RouteId, HTMLElement>} */
  const routePanels = new Map();

  for (const route of routes) {
    const shell = document.querySelector(`.page-panel-shell[data-route="${route}"]`);
    const panel = document.querySelector(`wa-tab-panel[name="${route}"]`);

    if (!(shell instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      throw new Error(`Missing tab panel shell for route: ${route}`);
    }

    routeShells.set(route, shell);
    routePanels.set(route, panel);
  }

  /** @type {Map<RouteId, Promise<void>>} */
  const routeInflationPromises = new Map();
  /** @type {Set<RouteId>} */
  const inflatedRoutes = new Set();

  let pendingLoads = 0;
  /** @type {RouteId | null} */
  let activeRoute = null;

  /**
   * @param {RouteId} route
   */
  function setActiveNavigation(route) {
    for (const button of navButtons) {
      const buttonRoute = button.dataset.route;
      const isActive = buttonRoute === route;

      button.classList.toggle('is-active', isActive);

      if (isActive) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    }
  }

  /**
   * @param {boolean} isLoading
   */
  function setLoading(isLoading) {
    pendingLoads += isLoading ? 1 : -1;
    if (pendingLoads < 0) {
      pendingLoads = 0;
    }

    pageView.classList.toggle('is-loading', pendingLoads > 0);
  }

  /**
   * @param {RouteId} route
   * @param {string} message
   */
  function renderRouteError(route, message) {
    const shell = routeShells.get(route);
    if (!shell) {
      return;
    }

    shell.innerHTML = `
      <wa-callout variant="danger">
        Failed to load <strong>${route}</strong>: ${message}
      </wa-callout>
    `;
  }

  /**
   * @param {RouteId} route
   */
  async function inflateRoute(route) {
    if (inflatedRoutes.has(route)) {
      return;
    }

    const existingPromise = routeInflationPromises.get(route);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    const inflatePromise = (async () => {
      setLoading(true);

      try {
        const tagName = routeElementTags[route];
        await customElements.whenDefined(tagName);

        const shell = routeShells.get(route);
        if (!shell) {
          throw new Error(`Missing shell for route ${route}`);
        }

        const existingPage = shell.querySelector(`:scope > ${tagName}`);
        if (!existingPage) {
          shell.replaceChildren(document.createElement(tagName));
        }

        inflatedRoutes.add(route);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        renderRouteError(route, message);
        throw error;
      } finally {
        setLoading(false);
      }
    })();

    routeInflationPromises.set(route, inflatePromise);
    try {
      await inflatePromise;
    } finally {
      routeInflationPromises.delete(route);
    }
  }

  /**
   * @param {RouteId} route
   */
  function showRoutePanel(route) {
    const tabGroupWithShow = /** @type {{ show?: (name: string) => void }} */ (pageTabs);
    if (typeof tabGroupWithShow.show === 'function') {
      tabGroupWithShow.show(route);
    }

    for (const [panelRoute, panel] of routePanels.entries()) {
      const isActive = panelRoute === route;
      /** @type {{ active?: boolean }} */ (panel).active = isActive;
      panel.toggleAttribute('active', isActive);
      panel.toggleAttribute('hidden', !isActive);
      panel.setAttribute('aria-hidden', String(!isActive));
    }
  }

  /**
   * @param {RouteId} route
   */
  function animateRouteEntry(route) {
    const panel = routePanels.get(route);
    if (!panel) {
      return;
    }

    panel.classList.remove('is-entering');
    void panel.offsetWidth;
    panel.classList.add('is-entering');

    panel.addEventListener('animationend', () => {
      panel.classList.remove('is-entering');
    }, { once: true });
  }

  function hideMobileNavigationDrawer() {
    const page = document.querySelector('wa-page');
    if (!(page instanceof HTMLElement)) {
      return;
    }

    const pageWithNavigation = /** @type {{ hideNavigation?: () => void; navOpen?: boolean }} */ (page);

    if (typeof pageWithNavigation.hideNavigation === 'function') {
      pageWithNavigation.hideNavigation();
      return;
    }

    if (typeof pageWithNavigation.navOpen === 'boolean') {
      pageWithNavigation.navOpen = false;
      return;
    }

    page.removeAttribute('nav-open');
  }

  /**
   * @param {RouteId} route
   */
  async function activateRoute(route) {
    pageView.setAttribute('aria-busy', 'true');

    try {
      await inflateRoute(route);

      activeRoute = route;
      setActiveNavigation(route);
      showRoutePanel(route);
      hideMobileNavigationDrawer();
      options.onRouteActivated?.(route);
      animateRouteEntry(route);

      return pageTabs;
    } finally {
      pageView.setAttribute('aria-busy', 'false');
    }
  }

  function setNavButtonLinks() {
    for (const button of navButtons) {
      const routeValue = button.dataset.route;
      if (!routeValue || !isRouteId(routeValue)) {
        continue;
      }

      button.setAttribute('href', routePath(routeValue));
      button.addEventListener('click', (event) => {
        event.preventDefault();
        Router.go(routePath(routeValue));
      });
    }
  }

  const router = new Router(pageView);

  async function init() {
    setNavButtonLinks();

    await router.setRoutes([
      { path: '/', action: (_context, commands) => commands.redirect('/home') },
      { path: '/index.html', action: (_context, commands) => commands.redirect('/home') },
      ...routes.map((route) => ({
        path   : routePath(route),
        action : async () => activateRoute(route),
      })),
      {
        path   : '/index.html/:route',
        action : (context, commands) => {
          const routeParam = context.params.route;
          const routeValue = typeof routeParam === 'string' ? routeParam : '';
          return isRouteId(routeValue)
            ? commands.redirect(routePath(routeValue))
            : commands.redirect('/home');
        },
      },
      { path: '(.*)', action: (_context, commands) => commands.redirect('/home') },
    ]);
  }

  return {
    init,
    activateRoute,
    navigate : (route) => Router.go(routePath(route)),
    getActiveRoute : () => activeRoute,
    router,
  };
}
