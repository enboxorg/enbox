import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { createRef, ref } from 'lit/directives/ref.js';
import { appContext } from '../../state/app-context.js';
import { getAppStore } from '../../state/app-store.js';
import { getModuleCatalogEntry, getModuleInstallPlan, moduleCatalog } from './module-catalog.js';
import './index.css';

const identityRuntimeWindowKey = '__identityRuntime';

/**
 * @typedef {{
 *   did: string;
 *   modules: string[];
 * }} InstalledModulesSnapshot
 */

/**
 * @typedef {{
 *   module: string;
 *   [key: string]: unknown;
 * }} ModuleDefinitionLike
 */

/**
 * @typedef {{
 *   did: string;
 *   module: string;
 *   alreadyInstalled: boolean;
 *   status: {
 *     code: number;
 *     detail: string;
 *     [key: string]: unknown;
 *   };
 * }} EnsureModuleInstalledResult
 */

/**
 * @typedef {{
 *   did: string;
 *   module: string;
 *   listInstalledModules: () => Promise<InstalledModulesSnapshot>;
 *   ensureModuleInstalled: (definition: ModuleDefinitionLike) => Promise<EnsureModuleInstalledResult>;
 * }} IdentityRuntime
 */

class AppsPage extends SignalWatcher(LitElement) {
  static properties = {
    installedModules     : { state: true },
    installingModules    : { state: true },
    isModuleStateLoading : { state: true },
    moduleLoadError      : { state: true },
    moduleSearch         : { state: true },
    moduleStatusDid      : { state: true },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.appStore = null;
    this.installedModules = new Set();
    this.installingModules = new Set();
    this.isModuleStateLoading = false;
    this.moduleLoadError = '';
    this.moduleSearch = '';
    this.moduleStatusDid = '';
    this._observedModuleDid = '';
    this._moduleStatusRequestId = 0;
    this.moduleDialogRef = createRef();
    this.moduleSearchInputRef = createRef();
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  updated() {
    const currentDid = this.currentDid;
    if (currentDid === this._observedModuleDid) {
      return;
    }

    this._observedModuleDid = currentDid;
    this.installedModules = new Set();
    this.installingModules = new Set();
    this.isModuleStateLoading = false;
    this.moduleLoadError = '';
    this.moduleSearch = '';
    this.moduleStatusDid = '';

    if (!currentDid) {
      return;
    }

    void this.loadInstalledModules(currentDid);
  }

  get connections() {
    return this.appStore?.apps.connections.get() ?? [];
  }

  get accordionItems() {
    return this.connections.map((app) => toAccordionItem(app));
  }

  get identitySnapshot() {
    return this.appStore?.identity.walletSnapshot.get() ?? null;
  }

  get currentDid() {
    const snapshot = this.identitySnapshot;
    if (!snapshot || typeof snapshot !== 'object') {
      return '';
    }

    const activeDid = typeof snapshot.activeDid === 'string'
      ? snapshot.activeDid.trim()
      : '';
    if (activeDid) {
      return activeDid;
    }

    const activeManagedDidUri = typeof snapshot.activeManagedDidUri === 'string'
      ? snapshot.activeManagedDidUri.trim()
      : '';
    return activeManagedDidUri;
  }

  get hasActiveDid() {
    return this.currentDid.length > 0;
  }

  get filteredModules() {
    const normalizedQuery = this.moduleSearch.trim().toLowerCase();

    return [...moduleCatalog]
      .filter((entry) => normalizedQuery.length === 0 || entry.searchText.includes(normalizedQuery))
      .sort((left, right) => {
        const leftInstalled = this.isModuleInstalled(left.module) ? 1 : 0;
        const rightInstalled = this.isModuleInstalled(right.module) ? 1 : 0;

        if (leftInstalled !== rightInstalled) {
          return rightInstalled - leftInstalled;
        }

        return left.name.localeCompare(right.name);
      });
  }

  render() {
    return html`
      <div class="wa-stack wa-gap-xl dashboard page-block apps-page">
        <section class="wa-stack wa-gap-s">
          <div class="wa-flank:end">
            <h1>Apps</h1>
            <div class="wa-cluster wa-gap-xs apps-header-actions">
              <wa-button appearance="outlined" variant="brand">
                <wa-icon slot="start" name="plus" variant="solid"></wa-icon>
                Install App
              </wa-button>

              <wa-button
                appearance="outlined"
                ?disabled=${!this.hasActiveDid}
                @click=${this.onOpenInstallModuleDialog}
              >
                <wa-icon slot="start" name="plus" variant="solid"></wa-icon>
                Install Module
              </wa-button>
            </div>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

          <div class="wa-caption-m apps-connections-intro">
            Applications with active connections to your DWN identity.
          </div>
        </section>

        <x-accordion
          class="apps-connections-list"
          aria-live="polite"
          aria-label="Connected applications"
          empty-text="No app connections found."
          .items=${this.accordionItems}
        ></x-accordion>

        ${this.renderModuleDialog()}
      </div>
    `;
  }

  renderModuleDialog() {
    return html`
      <wa-dialog
        ${ref(this.moduleDialogRef)}
        id="apps-install-module-dialog"
        light-dismiss
        @wa-after-hide=${this.onModuleDialogAfterHide}
      >
        <div slot="label" class="wa-cluster wa-gap-xs">
          <wa-icon name="circle-plus" variant="solid"></wa-icon>
          Install Module
        </div>

        <div class="wa-stack wa-gap-s apps-module-dialog-body">
          <div class="wa-stack wa-gap-s apps-module-dialog-controls">
            <wa-input
              ${ref(this.moduleSearchInputRef)}
              class="apps-module-search"
              placeholder="Search modules"
              pill
              autocapitalize="none"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
              .value=${this.moduleSearch}
              @input=${this.onModuleSearchInput}
            >
              <wa-icon slot="start" name="magnifying-glass"></wa-icon>
            </wa-input>

            ${this.moduleLoadError
              ? html`<wa-callout variant="danger">${this.moduleLoadError}</wa-callout>`
              : ''}
          </div>

          <div class="apps-module-list" role="list" aria-label="Available modules">
            ${this.renderModuleList()}
          </div>
        </div>
      </wa-dialog>
    `;
  }

  renderModuleList() {
    if (!this.hasActiveDid) {
      return html`
        <wa-callout variant="warning">
          Select or unlock a DID before installing modules.
        </wa-callout>
      `;
    }

    if (this.isModuleStateLoading && this.moduleStatusDid !== this.currentDid) {
      return html`
        <div class="wa-stack wa-align-items-center wa-gap-s apps-module-loading">
          <wa-spinner style="font-size: 1.75rem"></wa-spinner>
          <div class="wa-caption-m">Loading installed modules</div>
        </div>
      `;
    }

    if (this.filteredModules.length === 0) {
      return html`
        <div class="wa-caption-m apps-module-empty">
          No modules match your search.
        </div>
      `;
    }

    return this.filteredModules.map((entry) => this.renderModuleListItem(entry));
  }

  /**
   * @param {{
   *   name: string;
   *   module: string;
   *   moduleUrl: string;
   *   publisher: string;
   * }} entry
   * @returns {import('lit').TemplateResult}
   */
  renderModuleListItem(entry) {
    const isInstalled = this.isModuleInstalled(entry.module);
    const isInstalling = this.isModuleInstalling(entry.module);
    const faviconUrl = googleFaviconUrl(entry.moduleUrl);
    const actionLabel = isInstalling
      ? 'Installing'
      : isInstalled
        ? 'Installed'
        : 'Install';
    const actionVariant = isInstalled ? 'brand' : 'success';

    return html`
        <div role="listitem" class="apps-module-list-row">
          <div class="apps-module-list-item ${isInstalled ? 'is-installed' : ''}">
            <wa-avatar
              class="apps-module-avatar"
            image=${faviconUrl || ''}
            initials=${moduleInitials(entry.name)}
            label=${`${entry.name} icon`}
            shape="rounded"
          ></wa-avatar>

          <div class="apps-module-list-main">
            <div class="apps-module-list-topline">
              <div class="wa-stack wa-gap-3xs">
                <div class="apps-module-list-title">${entry.name}</div>
                <div class="wa-caption-s apps-module-list-publisher">${entry.publisher}</div>
              </div>
            </div>
          </div>

          <div class="apps-module-list-action">
            <wa-button
              size="small"
              variant=${actionVariant}
              ?loading=${isInstalling}
              ?disabled=${isInstalling || !this.hasActiveDid}
              @click=${() => {
                void this.onModuleSelect(entry.module);
              }}
            >
              ${actionLabel}
            </wa-button>
          </div>
        </div>
      </div>
    `;
  }

  onOpenInstallModuleDialog = () => {
    if (!this.hasActiveDid) {
      this.notify('warning', 'Select or unlock a DID before installing modules.');
      return;
    }

    this.moduleSearch = '';

    if (this.moduleStatusDid !== this.currentDid && !this.isModuleStateLoading) {
      void this.loadInstalledModules(this.currentDid);
    }

    const dialog = this.moduleDialogRef.value;
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    const focusWhenReady = () => {
      const input = this.moduleSearchInputRef.value;
      if (input instanceof HTMLElement && typeof input.focus === 'function') {
        input.focus();
      }
    };

    dialog.addEventListener('wa-after-show', focusWhenReady, { once: true });
    dialog.addEventListener('wa-show', focusWhenReady, { once: true });
    this.openDialog(dialog);
  };

  onModuleDialogAfterHide = () => {
    this.moduleSearch = '';
  };

  /**
   * @param {Event} event
   */
  onModuleSearchInput = (event) => {
    this.moduleSearch = readFieldValue(event.target);
  };

  /**
   * @param {string} expectedDid
   * @returns {Promise<void>}
   */
  async loadInstalledModules(expectedDid = this.currentDid) {
    const runtime = getIdentityRuntime();
    if (!runtime || !expectedDid) {
      return;
    }

    const requestId = this._moduleStatusRequestId + 1;
    this._moduleStatusRequestId = requestId;
    this.isModuleStateLoading = true;
    this.moduleLoadError = '';

    try {
      const snapshot = await runtime.listInstalledModules();
      if (requestId !== this._moduleStatusRequestId || expectedDid !== this.currentDid) {
        return;
      }

      this.installedModules = new Set(snapshot.modules);
      this.moduleStatusDid = expectedDid;
    } catch (error) {
      if (requestId !== this._moduleStatusRequestId || expectedDid !== this.currentDid) {
        return;
      }

      this.installedModules = new Set();
      this.moduleStatusDid = '';
      this.moduleLoadError = error instanceof Error
        ? error.message
        : String(error ?? 'Failed to load installed modules.');
    } finally {
      if (requestId === this._moduleStatusRequestId && expectedDid === this.currentDid) {
        this.isModuleStateLoading = false;
      }
    }
  }

  /**
   * @param {string} moduleUri
   * @returns {Promise<void>}
   */
  async onModuleSelect(moduleUri) {
    const runtime = getIdentityRuntime();
    if (!runtime) {
      this.notify('danger', 'Identity runtime is unavailable.');
      return;
    }

    const currentDid = this.currentDid;
    if (!currentDid) {
      this.notify('warning', 'Select or unlock a DID before installing modules.');
      return;
    }

    const selectedEntry = getModuleCatalogEntry(moduleUri);
    if (!selectedEntry) {
      this.notify('danger', 'The selected module is not available in this build.');
      return;
    }

    const { plan, missingDependencies } = getModuleInstallPlan(moduleUri);
    if (missingDependencies.length > 0) {
      this.notify(
        'danger',
        `Cannot install ${selectedEntry.name}: missing dependency definitions for ${missingDependencies.join(', ')}.`,
      );
      return;
    }

    const planUris = plan.map((entry) => entry.module);
    this.setInstallingModules(planUris, true);

    try {
      const newlyInstalled = [];

      for (const entry of plan) {
        const result = await runtime.ensureModuleInstalled(entry.definition);

        if (currentDid !== this.currentDid) {
          return;
        }

        if (!result.alreadyInstalled) {
          newlyInstalled.push(entry.name);
        }

        this.markModulesInstalled([entry.module]);
      }

      this.moduleStatusDid = currentDid;

      if (newlyInstalled.length === 0) {
        this.notify('neutral', `${selectedEntry.name} is already installed on ${currentDid}.`);
        return;
      }

      this.notify('success', `Installed ${formatNameList(newlyInstalled)} on ${currentDid}.`);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error ?? 'Unknown module install error.');
      this.notify('danger', `Failed to install ${selectedEntry.name}: ${message}`);
      void this.loadInstalledModules(currentDid);
    } finally {
      if (currentDid === this.currentDid) {
        this.setInstallingModules(planUris, false);
      }
    }
  }

  /**
   * @param {'neutral' | 'brand' | 'success' | 'warning' | 'danger'} tone
   * @param {string} message
   */
  notify(tone, message) {
    const toastStore = this.appStore?.toast ?? getAppStore().toast;
    toastStore.notify({
      tone,
      message,
      dedupeWindowMs : 1200,
      allowDuplicate : false,
    });
  }

  /**
   * @param {string[]} moduleUris
   */
  markModulesInstalled(moduleUris) {
    const nextInstalledModules = new Set(this.installedModules);
    for (const moduleUri of moduleUris) {
      const normalizedModuleUri = String(moduleUri ?? '').trim();
      if (normalizedModuleUri) {
        nextInstalledModules.add(normalizedModuleUri);
      }
    }

    this.installedModules = nextInstalledModules;
  }

  /**
   * @param {string[]} moduleUris
   * @param {boolean} isInstalling
   */
  setInstallingModules(moduleUris, isInstalling) {
    const nextInstallingModules = new Set(this.installingModules);

    for (const moduleUri of moduleUris) {
      const normalizedModuleUri = String(moduleUri ?? '').trim();
      if (!normalizedModuleUri) {
        continue;
      }

      if (isInstalling) {
        nextInstallingModules.add(normalizedModuleUri);
      } else {
        nextInstallingModules.delete(normalizedModuleUri);
      }
    }

    this.installingModules = nextInstallingModules;
  }

  /**
   * @param {string} moduleUri
   * @returns {boolean}
   */
  isModuleInstalled(moduleUri) {
    return this.installedModules.has(String(moduleUri ?? '').trim());
  }

  /**
   * @param {string} moduleUri
   * @returns {boolean}
   */
  isModuleInstalling(moduleUri) {
    return this.installingModules.has(String(moduleUri ?? '').trim());
  }

  /**
   * @param {HTMLElement | null | undefined} dialog
   */
  openDialog(dialog) {
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    const open = /** @type {{ show?: () => Promise<void> | void }} */ (dialog).show;
    if (typeof open === 'function') {
      void open.call(dialog);
      return;
    }

    dialog.setAttribute('open', '');
  }

}

if (!customElements.get('apps-page')) {
  customElements.define('apps-page', AppsPage);
}

/**
 * @returns {IdentityRuntime | null}
 */
function getIdentityRuntime() {
  const runtime = window[identityRuntimeWindowKey];
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }

  const requiredMethods = [
    'listInstalledModules',
    'ensureModuleInstalled',
  ];

  for (const methodName of requiredMethods) {
    if (typeof runtime[methodName] !== 'function') {
      return null;
    }
  }

  return /** @type {IdentityRuntime} */ (runtime);
}

/**
 * @param {string} value
 * @returns {string}
 */
function moduleInitials(value) {
  const words = String(value ?? '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length === 0) {
    return 'PR';
  }

  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * @param {string[]} names
 * @returns {string}
 */
function formatNameList(names) {
  if (names.length <= 1) {
    return names[0] ?? '';
  }

  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }

  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/**
 * @param {EventTarget | null} target
 * @returns {string}
 */
function readFieldValue(target) {
  if (!target || typeof target !== 'object' || !('value' in target)) {
    return '';
  }

  return String(target.value ?? '');
}

/**
 * @param {string} url
 * @returns {string}
 */
function appOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * @param {string} url
 * @returns {string | null}
 */
function googleFaviconUrl(url) {
  try {
    const parsed = new URL(url);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.hostname)}`;
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined} isoDate
 * @returns {string}
 */
function formatDateTime(isoDate) {
  if (typeof isoDate !== 'string' || isoDate.trim().length === 0) {
    return 'Unknown';
  }

  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle : 'medium',
    timeStyle : 'short',
  }).format(parsed);
}

/**
 * @param {import('../../state/app-store.js').AppConnection} app
 * @returns {Record<string, unknown>}
 */
function toAccordionItem(app) {
  return {
    id             : app.id,
    title          : app.name,
    subtitle       : `(${appOrigin(app.url)})`,
    avatarSrc      : app.iconUrl ?? googleFaviconUrl(app.url),
    avatarFallback : app.name,
    description    : app.description ?? 'No description available.',
    meta           : [
      { label: 'Connected', value: formatDateTime(app.connectedAt) },
      { label: 'Status', value: app.status ?? 'Unknown' },
      { label: 'Last activity', value: formatDateTime(app.lastActivityAt) },
    ],
    tagsLabel : 'Scopes',
    tags      : Array.isArray(app.scopes) && app.scopes.length > 0 ? app.scopes : ['No scopes listed'],
  };
}
