/**
 * @typedef {object} WebAwesomeKitConfigLike
 * @property {string=} kit_assets_base_url
 * @property {string=} token
 * @property {string=} product_version
 */

let discoverModulePromise = null;
let discoverUnavailableLogged = false;
const pendingDiscoveryRoots = new WeakSet();

/**
 * @returns {string | null}
 */
function resolveWebAwesomeLoaderUrl() {
  const runtime = /** @type {Window & { WebAwesomeKitConfig?: WebAwesomeKitConfigLike }} */ (window);
  const config = runtime.WebAwesomeKitConfig;
  if (!config || typeof config !== 'object') {
    return null;
  }

  const baseUrl = typeof config.kit_assets_base_url === 'string' ? config.kit_assets_base_url : '';
  const token = typeof config.token === 'string' ? config.token : '';
  const version = typeof config.product_version === 'string' ? config.product_version : '';
  if (!baseUrl || !token || !version) {
    return null;
  }

  return `${baseUrl}/kit/${token}/webawesome@${version}/webawesome.loader.js`;
}

/**
 * @returns {Promise<((root: Document | ShadowRoot | Element) => Promise<void>) | null>}
 */
async function loadDiscover() {
  if (discoverModulePromise) {
    return discoverModulePromise;
  }

  discoverModulePromise = (async () => {
    const moduleUrl = resolveWebAwesomeLoaderUrl();
    if (!moduleUrl) {
      return null;
    }

    try {
      const module = await import(moduleUrl);
      return typeof module.discover === 'function'
        ? /** @type {(root: Document | ShadowRoot | Element) => Promise<void>} */ (module.discover)
        : null;
    } catch (error) {
      if (!discoverUnavailableLogged) {
        discoverUnavailableLogged = true;
        console.warn('Unable to load Web Awesome discover() API', error);
      }
      return null;
    }
  })();

  return discoverModulePromise;
}

/**
 * Explicitly discover and register `wa-*` elements under a root, including shadow roots.
 *
 * @param {Document | ShadowRoot | Element | null | undefined} root
 * @returns {Promise<void>}
 */
export async function discoverWebAwesome(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return;
  }

  const discover = await loadDiscover();
  if (typeof discover !== 'function') {
    return;
  }

  await discover(root);
}

/**
 * Schedule a deduplicated discovery pass for a root on the next microtask.
 *
 * @param {Document | ShadowRoot | Element | null | undefined} root
 */
export function requestWebAwesomeDiscovery(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return;
  }

  if (pendingDiscoveryRoots.has(root)) {
    return;
  }

  pendingDiscoveryRoots.add(root);
  queueMicrotask(async () => {
    try {
      await discoverWebAwesome(root);
    } finally {
      pendingDiscoveryRoots.delete(root);
    }
  });
}
