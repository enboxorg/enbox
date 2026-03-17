const componentStyleIdSymbol = Symbol.for('enbox.app.componentStyleId');
const componentStyleLinkAttribute = 'data-enbox-component-style';

/** @type {Map<string, Promise<CSSStyleSheet>>} */
const componentStylesheetCache = new Map();

/**
 * @param {string} componentName
 * @param {string} cssUrl
 * @returns {Promise<CSSStyleSheet>}
 */
async function getOrCreateComponentStyleSheet(componentName, cssUrl) {
  const existing = componentStylesheetCache.get(componentName);
  if (existing) {
    return existing;
  }

  const stylesheetPromise = (async () => {
    const response = await fetch(cssUrl);
    const stylesheetText = await response.text();
    // Custom protocols like `views://` may not map `ok` reliably, even when
    // the body is valid. Treat empty content as the actual failure signal.
    if (!response.ok && stylesheetText.trim().length === 0) {
      throw new Error(`Failed to load stylesheet for ${componentName} (${response.status})`);
    }

    if (stylesheetText.trim().length === 0) {
      throw new Error(`Stylesheet for ${componentName} is empty`);
    }

    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(stylesheetText);

    Object.defineProperty(stylesheet, componentStyleIdSymbol, {
      value: componentName,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    return stylesheet;
  })();

  componentStylesheetCache.set(componentName, stylesheetPromise);

  try {
    return await stylesheetPromise;
  } catch (error) {
    componentStylesheetCache.delete(componentName);
    throw error;
  }
}

/**
 * @param {Document | ShadowRoot} target
 * @param {string} componentName
 * @returns {CSSStyleSheet | null}
 */
function findAdoptedComponentStyleSheet(target, componentName) {
  if (!('adoptedStyleSheets' in target)) {
    return null;
  }

  const adoptedStyleSheets = target.adoptedStyleSheets;
  if (!Array.isArray(adoptedStyleSheets)) {
    return null;
  }

  return adoptedStyleSheets.find((sheet) => sheet[componentStyleIdSymbol] === componentName) ?? null;
}

/**
 * @param {Document | ShadowRoot} target
 * @returns {ParentNode | null}
 */
function getFallbackStyleContainer(target) {
  if (target instanceof ShadowRoot) {
    return target;
  }

  if (target instanceof Document) {
    return target.head ?? target.documentElement;
  }

  return null;
}

/**
 * @param {Document | ShadowRoot} target
 * @param {string} componentName
 * @returns {HTMLLinkElement | null}
 */
function findFallbackStylesheetLink(target, componentName) {
  const styleContainer = getFallbackStyleContainer(target);
  if (!styleContainer) {
    return null;
  }

  const selector = `link[rel="stylesheet"][${componentStyleLinkAttribute}="${componentName}"]`;
  const existingLink = styleContainer.querySelector(selector);
  return existingLink instanceof HTMLLinkElement ? existingLink : null;
}

/**
 * @param {Document | ShadowRoot} target
 * @param {string} componentName
 * @param {string} stylesheetUrl
 */
function ensureFallbackStylesheetLink(target, componentName, stylesheetUrl) {
  if (findFallbackStylesheetLink(target, componentName)) {
    return;
  }

  const styleContainer = getFallbackStyleContainer(target);
  if (!styleContainer) {
    return;
  }

  const fallbackLink = document.createElement('link');
  fallbackLink.rel = 'stylesheet';
  fallbackLink.href = stylesheetUrl;
  fallbackLink.setAttribute(componentStyleLinkAttribute, componentName);
  styleContainer.appendChild(fallbackLink);
}

/**
 * Adopt a component-local stylesheet once for a target root.
 *
 * @param {string} componentName
 * @param {URL | string} cssUrl
 * @param {Document | ShadowRoot=} target
 * @returns {Promise<void>}
 */
export async function adoptComponentStyle(componentName, cssUrl, target = document) {
  const stylesheetUrl = typeof cssUrl === 'string' ? cssUrl : cssUrl.toString();

  if (findAdoptedComponentStyleSheet(target, componentName) || findFallbackStylesheetLink(target, componentName)) {
    return;
  }

  if (!('adoptedStyleSheets' in target) || typeof CSSStyleSheet === 'undefined') {
    ensureFallbackStylesheetLink(target, componentName, stylesheetUrl);
    return;
  }

  try {
    const stylesheet = await getOrCreateComponentStyleSheet(componentName, stylesheetUrl);

    const existingAdoptedSheetAfterLoad = findAdoptedComponentStyleSheet(target, componentName);
    if (existingAdoptedSheetAfterLoad || findFallbackStylesheetLink(target, componentName)) {
      return;
    }

    const adoptedStyleSheets = target.adoptedStyleSheets;
    if (!Array.isArray(adoptedStyleSheets)) {
      ensureFallbackStylesheetLink(target, componentName, stylesheetUrl);
      return;
    }

    if (adoptedStyleSheets.includes(stylesheet)) {
      return;
    }

    target.adoptedStyleSheets = [...adoptedStyleSheets, stylesheet];
  } catch {
    ensureFallbackStylesheetLink(target, componentName, stylesheetUrl);
  }
}
