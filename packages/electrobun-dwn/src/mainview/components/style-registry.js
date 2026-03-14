const componentStyleIdSymbol = Symbol.for('enbox.app.componentStyleId');

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
  const adoptedStyleSheets = target.adoptedStyleSheets;
  return adoptedStyleSheets.find((sheet) => sheet[componentStyleIdSymbol] === componentName) ?? null;
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
  const existingAdoptedSheet = findAdoptedComponentStyleSheet(target, componentName);
  if (existingAdoptedSheet) {
    return;
  }

  const stylesheetUrl = typeof cssUrl === 'string' ? cssUrl : cssUrl.toString();
  const stylesheet = await getOrCreateComponentStyleSheet(componentName, stylesheetUrl);

  const existingAdoptedSheetAfterLoad = findAdoptedComponentStyleSheet(target, componentName);
  if (existingAdoptedSheetAfterLoad) {
    return;
  }

  const adoptedStyleSheets = target.adoptedStyleSheets;

  if (adoptedStyleSheets.includes(stylesheet)) {
    return;
  }

  target.adoptedStyleSheets = [...adoptedStyleSheets, stylesheet];
}
