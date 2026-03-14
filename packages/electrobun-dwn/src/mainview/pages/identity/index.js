import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { createRef, ref } from 'lit/directives/ref.js';
import '../../components/identity-create-wizard/index.js';
import '../../components/pin-pad/index.js';
import '../../components/x-menubar/index.js';
import { appContext } from '../../state/app-context.js';
import { getAppStore } from '../../state/app-store.js';
import { switchDidWithToast } from '../../utils/identity-switch.js';
import './index.css';

const identityRuntimeWindowKey = '__identityRuntime';

/**
 * @typedef {Object} ManagedIdentitySnapshot
 * @property {string} didUri
 * @property {string} name
 * @property {string=} connectedDid
 * @property {boolean} active
 * @property {string} connectedTargetDid
 * @property {'local' | 'delegated'} kind
 */

/**
 * @typedef {Object} IdentityWalletSnapshot
 * @property {'uninitialized' | 'locked' | 'unlocked' | 'connected'} authState
 * @property {boolean} isConnected
 * @property {boolean} isLocked
 * @property {boolean} isConnecting
 * @property {string=} activeDid
 * @property {string=} delegateDid
 * @property {string=} activeManagedDidUri
 * @property {ManagedIdentitySnapshot[]} identities
 * @property {string=} latestRecoveryPhrase
 * @property {string=} localDwnEndpoint
 * @property {string=} lastError
 * @property {string} lastUpdatedAt
 */

/**
 * @typedef {Object} IdentityDetails
 * @property {ManagedIdentitySnapshot} identity
 * @property {Record<string, unknown>} managedDidResolution
 * @property {Record<string, unknown>=} connectedDidResolution
 * @property {string[]} dwnEndpoints
 * @property {Record<string, unknown>=} syncOptions
 */

/**
 * @typedef {Object} ExportedIdentity
 * @property {string} didUri
 * @property {string} name
 * @property {Record<string, unknown>} portableIdentity
 * @property {string} json
 */

/**
 * @typedef {Object} IdentityRuntime
 * @property {() => Promise<IdentityWalletSnapshot>} initialize
 * @property {() => Promise<IdentityWalletSnapshot>} refresh
 * @property {(options?: { password?: string; name?: string; dwnEndpoints?: string[]; recoveryPhrase?: string; }) => Promise<IdentityWalletSnapshot>} connectLocal
 * @property {(options?: { password?: string; name?: string; dwnEndpoints?: string[]; }) => Promise<IdentityWalletSnapshot>} createDid
 * @property {(options: { recoveryPhrase: string; password: string; dwnEndpoints?: string[]; }) => Promise<IdentityWalletSnapshot>} importFromPhrase
 * @property {(options: { portableIdentity: Record<string, unknown>; password?: string; dwnEndpoints?: string[]; }) => Promise<IdentityWalletSnapshot>} importFromPortable
 * @property {(didUri: string) => Promise<IdentityWalletSnapshot>} switchDid
 * @property {(options: { didUri: string; name: string; password?: string; }) => Promise<IdentityWalletSnapshot>} renameDid
 * @property {(options: { didUri: string; password?: string; }) => Promise<IdentityWalletSnapshot>} deleteDid
 * @property {(didUri: string) => Promise<ExportedIdentity>} exportDid
 * @property {(didUri: string) => Promise<IdentityDetails>} getDidDetails
 * @property {(didUri: string) => Promise<Record<string, unknown>>} resolveDid
 * @property {(options: { didUri: string; endpoints: string[]; password?: string; }) => Promise<IdentityWalletSnapshot>} setDidEndpoints
 * @property {() => Promise<IdentityWalletSnapshot>} lock
 * @property {(password: string) => Promise<IdentityWalletSnapshot>} unlock
 * @property {(clearStorage?: boolean) => Promise<IdentityWalletSnapshot>} disconnect
 * @property {() => Promise<IdentityWalletSnapshot>} clearRecoveryPhrase
 */

/**
 * @typedef {{ status: 'loading' } | { status: 'loaded'; details: IdentityDetails } | { status: 'error'; message: string }} ManagedDidDetailsState
 */

/**
 * @typedef {Object} CreateWizardFooterState
 * @property {boolean} requiresPinStep
 * @property {0 | 1} step
 * @property {boolean} canContinueFromDetails
 * @property {boolean} pinIsValid
 * @property {boolean} busy
 */

/**
 * @returns {IdentityRuntime | null}
 */
function getIdentityRuntime() {
  const runtime = window[identityRuntimeWindowKey];
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }

  const requiredMethods = [
    'initialize',
    'refresh',
    'createDid',
    'importFromPhrase',
    'importFromPortable',
    'switchDid',
    'renameDid',
    'deleteDid',
    'exportDid',
    'getDidDetails',
    'setDidEndpoints',
    'lock',
    'unlock',
    'clearRecoveryPhrase',
  ];

  for (const methodName of requiredMethods) {
    if (typeof runtime[methodName] !== 'function') {
      return null;
    }
  }

  return /** @type {IdentityRuntime} */ (runtime);
}

/**
 * @returns {CreateWizardFooterState}
 */
function defaultCreateWizardFooterState() {
  return {
    requiresPinStep: false,
    step: 0,
    canContinueFromDetails: false,
    pinIsValid: false,
    busy: false,
  };
}

/**
 * @param {unknown} value
 * @returns {CreateWizardFooterState}
 */
function normalizeCreateWizardFooterState(value) {
  const defaults = defaultCreateWizardFooterState();
  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const state = /** @type {Partial<CreateWizardFooterState>} */ (value);
  return {
    requiresPinStep: state.requiresPinStep === true,
    step: state.step === 1 ? 1 : 0,
    canContinueFromDetails: state.canContinueFromDetails === true,
    pinIsValid: state.pinIsValid === true,
    busy: state.busy === true,
  };
}

class IdentityPage extends SignalWatcher(LitElement) {
  static properties = {
    createWizardFooterState: { state: true },
    detailsByDidUri: { state: true },
    deleteDidUri: { state: true },
    expandedDidUris: { state: true },
    importMode: { state: true },
    isInitializing: { state: true },
    isRefreshing: { state: true },
    isVaultToggling: { state: true },
    isCreateSubmitting: { state: true },
    isDeleteSubmitting: { state: true },
    isPhraseSubmitting: { state: true },
    isPortableSubmitting: { state: true },
    isRenameSubmitting: { state: true },
    isUnlockSubmitting: { state: true },
    createWizardMode: { state: true },
    phraseValue: { state: true },
    phrasePassword: { state: true },
    phraseEndpoints: { state: true },
    portableJson: { state: true },
    portablePassword: { state: true },
    portableEndpoints: { state: true },
    recoveryPhraseDidUri: { state: true },
    renameDidUri: { state: true },
    renameValue: { state: true },
    unlockPassword: { state: true },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.createWizardFooterState = defaultCreateWizardFooterState();
    /** @type {Map<string, ManagedDidDetailsState>} */
    this.detailsByDidUri = new Map();
    /** @type {Set<string>} */
    this.expandedDidUris = new Set();

    this.importMode = 'phrase';

    this.isInitializing = false;
    this.isRefreshing = false;
    this.isVaultToggling = false;
    this.isCreateSubmitting = false;
    this.isDeleteSubmitting = false;
    this.isPhraseSubmitting = false;
    this.isPortableSubmitting = false;
    this.isRenameSubmitting = false;
    this.isUnlockSubmitting = false;

    this.createWizardMode = 'additional';

    this.deleteDidUri = '';
    this.phraseValue = '';
    this.phrasePassword = '';
    this.phraseEndpoints = '';

    this.portableJson = '';
    this.portablePassword = '';
    this.portableEndpoints = '';

    this.recoveryPhraseDidUri = '';
    this.renameDidUri = '';
    this.renameValue = '';
    this.unlockPassword = '';

    /** @type {IdentityRuntime | null} */
    this.runtime = getIdentityRuntime();
    this._initialized = false;
    this.appStore = null;

    /** @type {Map<string, number>} */
    this._detailsRequestIds = new Map();
    this._detailsRequestCounter = 0;
    /** @type {IdentityWalletSnapshot | null} */
    this._lastAppliedSnapshot = null;
    /** @type {IdentityWalletSnapshot | null} */
    this._lastAccordionSnapshot = null;

    this.createDialogRef = createRef();
    this.createWizardRef = createRef();
    this.deleteDialogRef = createRef();
    this.importDialogRef = createRef();
    this.recoveryDialogRef = createRef();
    this.renameDialogRef = createRef();
    this.renameInputRef = createRef();
    this.unlockDialogRef = createRef();
    this.unlockPinPadRef = createRef();
    this.accordionRef = createRef();
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  connectedCallback() {
    super.connectedCallback();

    if (!this._initialized) {
      this._initialized = true;
      if (!this.runtime) {
        this.showFeedback('danger', 'Identity runtime is unavailable. Check app initialization.');
      } else {
        void this.initializeView();
      }
    }
  }

  updated(changedProperties) {
    const snapshot = this.snapshot;
    if (snapshot && snapshot !== this._lastAppliedSnapshot) {
      this.applySnapshot(snapshot);
    }

    if (snapshot !== this._lastAccordionSnapshot || changedProperties.has('detailsByDidUri') || changedProperties.has('expandedDidUris')) {
      this._lastAccordionSnapshot = snapshot;
      this.syncAccordionItems();
    }
  }

  get snapshot() {
    return this.appStore?.identity.walletSnapshot.get() ?? null;
  }

  get identities() {
    return this.snapshot?.identities ?? [];
  }

  get activeManagedDidUri() {
    return this.snapshot?.activeManagedDidUri
      ?? this.identities.find((identity) => identity.active)?.didUri
      ?? '';
  }

  get isUninitializedVault() {
    return this.snapshot?.authState === 'uninitialized';
  }

  get showLockedState() {
    return !this.isInitializing && Boolean(this.snapshot?.isLocked) && this.identities.length > 0;
  }

  get showEmptyIdentityState() {
    return !this.isInitializing && this.identities.length === 0;
  }

  get createDialogTitle() {
    return this.createWizardMode === 'initial' ? 'Create Your First DID' : 'Create DID';
  }

  get createWizardPrimaryLabel() {
    return this.createWizardFooterState.requiresPinStep && this.createWizardFooterState.step === 0
      ? 'Next'
      : 'Create DID';
  }

  get showCreateWizardBackButton() {
    return this.createWizardFooterState.requiresPinStep && this.createWizardFooterState.step === 1;
  }

  get isCreateWizardPrimaryDisabled() {
    if (!this.runtime || this.isCreateSubmitting || this.createWizardFooterState.busy) {
      return true;
    }

    if (this.createWizardFooterState.requiresPinStep && this.createWizardFooterState.step === 1) {
      return !this.createWizardFooterState.pinIsValid;
    }

    return !this.createWizardFooterState.canContinueFromDetails;
  }

  get latestRecoveryPhrase() {
    return this.snapshot?.latestRecoveryPhrase?.trim() ?? '';
  }

  get hasGlobalRecoveryPhrase() {
    if (!this.latestRecoveryPhrase) {
      return false;
    }

    if (this.snapshot?.isLocked) {
      return false;
    }

    return this.identities.length > 0;
  }

  get deleteIdentityLabel() {
    if (!this.deleteDidUri) {
      return '';
    }

    const identity = this.identities.find(({ didUri }) => didUri === this.deleteDidUri);
    return identity?.name?.trim() || this.deleteDidUri;
  }

  get vaultButtonLabel() {
    if (this.isUninitializedVault) {
      return 'Vault Not Initialized';
    }

    if (this.snapshot?.isLocked) {
      return 'Vault Locked - Unlock';
    }

    return 'Vault Unlocked - Lock';
  }

  get vaultButtonIcon() {
    if (this.snapshot?.isLocked || this.isUninitializedVault) {
      return 'lock';
    }

    return 'lock-open';
  }

  get vaultButtonVariant() {
    if (this.isUninitializedVault) {
      return 'neutral';
    }

    if (this.snapshot?.isLocked) {
      return 'warning';
    }

    return 'success';
  }

  render() {
    return html`
      <div class="wa-stack wa-gap-xl dashboard page-block identity-page">
        <section class="wa-stack wa-gap-s">
          <div class="identity-header-row">
            <h1 style="margin: 0;">Identity</h1>
            <x-menubar
              id="identity-toolbar"
              size="small"
              class="identity-toolbar-actions"
              style=${this.showEmptyIdentityState ? 'display: none;' : ''}
            >
              <wa-button
                id="identity-refresh-button"
                size="small"
                appearance="outlined"
                ?disabled=${this.isRefreshing || this.isInitializing || !this.runtime}
                @click=${this.onRefresh}
              >
                <wa-icon slot="start" name="arrow-rotate-right" variant="solid"></wa-icon>
                ${this.isRefreshing ? 'Refreshing...' : 'Refresh'}
              </wa-button>
              <wa-button
                id="identity-open-create-dialog"
                size="small"
                appearance="outlined"
                ?disabled=${this.isInitializing || !this.runtime}
                @click=${this.onOpenToolbarCreateDialog}
              >
                <wa-icon slot="start" name="circle-plus" variant="solid"></wa-icon>
                Create DID
              </wa-button>
              <wa-button
                id="identity-open-import-dialog"
                size="small"
                appearance="outlined"
                ?disabled=${this.isInitializing || !this.runtime}
                @click=${this.onOpenImportDialog}
              >
                <wa-icon slot="start" name="file-import" variant="solid"></wa-icon>
                Import
              </wa-button>
              ${this.hasGlobalRecoveryPhrase
                ? html`
                    <wa-button
                      id="identity-open-recovery-dialog"
                      size="small"
                      appearance="outlined"
                      ?disabled=${this.isInitializing}
                      @click=${this.onOpenToolbarRecoveryDialog}
                    >
                      <wa-icon slot="start" name="key" variant="solid"></wa-icon>
                      View Seed
                    </wa-button>
                  `
                : ''}
              <wa-button
                id="identity-vault-toggle"
                size="small"
                appearance="outlined"
                variant=${this.vaultButtonVariant}
                ?disabled=${this.isInitializing || this.isVaultToggling || !this.runtime}
                @click=${this.onVaultTogglePressed}
              >
                <wa-icon slot="start" name=${this.vaultButtonIcon} variant="solid"></wa-icon>
                ${this.vaultButtonLabel}
              </wa-button>
            </x-menubar>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

        </section>

        ${this.showLockedState
          ? html`
              <section id="identity-locked-state" class="identity-locked-state">
                <div class="identity-locked-empty-state">
                  <wa-icon class="identity-locked-icon" name="lock" variant="solid"></wa-icon>
                  <div class="identity-locked-title">Identity Vault is Locked</div>
                  <div class="identity-locked-subtitle">Unlock to manage your DIDs and view identity details.</div>
                  <wa-button
                    id="identity-open-unlock-dialog"
                    variant="brand"
                    appearance="outlined"
                    size="medium"
                    ?disabled=${this.isUnlockSubmitting || this.isInitializing || !this.runtime}
                    @click=${this.onOpenUnlockDialog}
                  >
                    <wa-icon slot="start" name="lock-open" variant="solid"></wa-icon>
                    Unlock
                  </wa-button>
                </div>
              </section>
            `
          : this.showEmptyIdentityState
          ? html`
              <section id="identity-initial-state" class="identity-onboarding-state">
                <div class="identity-onboarding-empty-state">
                  <wa-icon class="identity-onboarding-icon" name="plus" variant="solid"></wa-icon>
                  <div class="identity-onboarding-title">
                    ${this.isUninitializedVault ? 'Create or Import a DID' : 'No DIDs in This Vault'}
                  </div>
                  <div class="identity-onboarding-subtitle">
                    ${this.isUninitializedVault
                      ? 'Create a new DID or import existing DIDs to get started.'
                      : 'This vault is ready. Create a new DID or import an existing one.'}
                  </div>
                  <div class="wa-cluster wa-gap-l wa-justify-content-center identity-onboarding-actions">
                    <wa-button
                      id="identity-initial-create-button"
                      variant="brand"
                      appearance="outlined"
                      size="medium"
                      ?disabled=${this.isInitializing || !this.runtime}
                      @click=${this.onOpenInitialCreateDialog}
                    >
                      <wa-icon slot="start" name="circle-plus" variant="solid"></wa-icon>
                      Create
                    </wa-button>

                    <wa-button
                      id="identity-initial-import-button"
                      variant="brand"
                      appearance="outlined"
                      size="medium"
                      ?disabled=${this.isInitializing || !this.runtime}
                      @click=${this.onOpenImportDialog}
                    >
                      <wa-icon slot="start" name="file-import" variant="solid"></wa-icon>
                      Import
                    </wa-button>
                  </div>
                </div>
              </section>
            `
          : html`
              <section id="identity-managed-section" class="identity-managed-section">
                <div class="identity-managed-header">
                  <h3>My DIDs</h3>
                </div>

                <x-accordion
                  ${ref(this.accordionRef)}
                  id="identity-list"
                  class="identity-list-accordion"
                  aria-live="polite"
                  aria-label="Managed DIDs"
                  empty-text="No identities yet."
                  @x-accordion-action=${this.onAccordionAction}
                  @x-accordion-item-show=${this.onAccordionShow}
                  @x-accordion-item-hide=${this.onAccordionHide}
                  @x-accordion-item-toggle=${this.onAccordionToggle}
                ></x-accordion>
              </section>
            `}

        <wa-dialog ${ref(this.createDialogRef)} id="identity-create-dialog" light-dismiss>
          <div slot="label" class="wa-cluster wa-gap-xs">
            <wa-icon name="circle-plus" variant="solid"></wa-icon>
            ${this.createDialogTitle}
          </div>

          <identity-create-wizard
            ${ref(this.createWizardRef)}
            mode=${this.createWizardMode}
            .busy=${this.isCreateSubmitting}
            @create-submit=${this.onCreateWizardSubmit}
            @wizard-state-change=${this.onCreateWizardStateChanged}
          ></identity-create-wizard>

          <div slot="footer" class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer">
            <wa-button appearance="plain" type="button" ?disabled=${this.isCreateSubmitting} @click=${this.onCloseCreateDialog}>
              Cancel
            </wa-button>
            ${this.showCreateWizardBackButton
              ? html`
                  <wa-button
                    appearance="outlined"
                    type="button"
                    ?disabled=${this.isCreateSubmitting}
                    @click=${this.onCreateWizardBackAction}
                  >
                    Back
                  </wa-button>
                `
              : ''}
            <wa-button
              id="identity-create-submit"
              variant="brand"
              type="button"
              ?loading=${this.isCreateSubmitting}
              ?disabled=${this.isCreateWizardPrimaryDisabled}
              @click=${this.onCreateWizardPrimaryAction}
            >
              ${this.createWizardPrimaryLabel}
            </wa-button>
          </div>
        </wa-dialog>

        <wa-dialog ${ref(this.importDialogRef)} id="identity-import-dialog" light-dismiss>
          <div slot="label" class="wa-cluster wa-gap-xs">
            <wa-icon name="file-import" variant="solid"></wa-icon>
            Import DID
          </div>

          <div class="wa-stack wa-gap-s identity-dialog-body">
            <wa-radio-group
              id="identity-import-mode"
              class="identity-import-mode"
              orientation="horizontal"
              .value=${this.importMode}
              @change=${this.onImportModeChanged}
              @wa-change=${this.onImportModeChanged}
            >
              <wa-radio value="phrase" appearance="button">Phrase</wa-radio>
              <wa-radio value="upload" appearance="button">Upload</wa-radio>
            </wa-radio-group>

            <div id="identity-import-phrase-panel" class="identity-import-panel" ?hidden=${this.importMode !== 'phrase'}>
              <form id="identity-import-phrase-form" class="wa-stack wa-gap-s" @submit=${this.onPhraseImportSubmit}>
                <wa-textarea
                  id="identity-phrase-value"
                  label="Recovery phrase"
                  rows="4"
                  placeholder="word1 word2 word3 ..."
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  .value=${this.phraseValue}
                  @input=${(event) => {
                    this.phraseValue = readFieldValue(event.target);
                  }}
                ></wa-textarea>

                <wa-input
                  id="identity-phrase-password"
                  type="password"
                  label="Vault PIN or password"
                  placeholder="Required"
                  .value=${this.phrasePassword}
                  @input=${(event) => {
                    this.phrasePassword = readFieldValue(event.target);
                  }}
                ></wa-input>

                <wa-textarea
                  id="identity-phrase-endpoints"
                  label="DWN endpoints (optional)"
                  placeholder="One endpoint per line"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  .value=${this.phraseEndpoints}
                  @input=${(event) => {
                    this.phraseEndpoints = readFieldValue(event.target);
                  }}
                ></wa-textarea>
              </form>
            </div>

            <div id="identity-import-upload-panel" class="identity-import-panel" ?hidden=${this.importMode !== 'upload'}>
              <form id="identity-import-upload-form" class="wa-stack wa-gap-s" @submit=${this.onPortableImportSubmit}>
                <wa-textarea
                  id="identity-portable-json"
                  label="PortableIdentity JSON"
                  rows="7"
                  placeholder='{"portableDid": ...}'
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  .value=${this.portableJson}
                  @input=${(event) => {
                    this.portableJson = readFieldValue(event.target);
                  }}
                ></wa-textarea>

                <wa-input
                  id="identity-portable-password"
                  type="password"
                  label="PIN or password (if vault locked/new)"
                  placeholder="Optional"
                  .value=${this.portablePassword}
                  @input=${(event) => {
                    this.portablePassword = readFieldValue(event.target);
                  }}
                ></wa-input>

                <wa-textarea
                  id="identity-portable-endpoints"
                  label="DWN endpoints (first-launch only)"
                  placeholder="One endpoint per line"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  .value=${this.portableEndpoints}
                  @input=${(event) => {
                    this.portableEndpoints = readFieldValue(event.target);
                  }}
                ></wa-textarea>
              </form>
            </div>
          </div>

          <div
            slot="footer"
            class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer"
            ?hidden=${this.importMode !== 'phrase'}
          >
            <wa-button appearance="plain" type="button" @click=${this.onCloseImportDialog}>Cancel</wa-button>
            <wa-button
              id="identity-phrase-submit"
              variant="brand"
              type="submit"
              form="identity-import-phrase-form"
              ?loading=${this.isPhraseSubmitting}
              ?disabled=${this.isPhraseSubmitting || !this.runtime}
            >
              <wa-icon slot="start" name="download" variant="solid"></wa-icon>
              Import Phrase
            </wa-button>
          </div>

          <div
            slot="footer"
            class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer"
            ?hidden=${this.importMode !== 'upload'}
          >
            <wa-button appearance="plain" type="button" @click=${this.onCloseImportDialog}>Cancel</wa-button>
            <wa-button
              id="identity-portable-submit"
              variant="brand"
              type="submit"
              form="identity-import-upload-form"
              ?loading=${this.isPortableSubmitting}
              ?disabled=${this.isPortableSubmitting || !this.runtime}
            >
              <wa-icon slot="start" name="file-import" variant="solid"></wa-icon>
              Import Upload
            </wa-button>
          </div>
        </wa-dialog>

        <wa-dialog ${ref(this.recoveryDialogRef)} id="identity-recovery-dialog" light-dismiss>
          <div slot="label" class="wa-cluster wa-gap-xs">
            <wa-icon name="key" variant="solid"></wa-icon>
            Recovery Phrase
          </div>

          <div class="wa-stack wa-gap-s identity-dialog-body">
            <div class="wa-caption-s">Save this recovery phrase in a secure place</div>

            <x-code class="identity-recovery-dialog-phrase" language="text" hide-copy>${this.latestRecoveryPhrase}</x-code>
          </div>

          <div slot="footer" class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer">
            <wa-button appearance="plain" @click=${this.onCloseRecoveryDialog}>Close</wa-button>
            <wa-button variant="brand" appearance="outlined" @click=${this.onCopyRecoveryPhrase}>
              <wa-icon slot="start" name="copy" variant="regular"></wa-icon>
              Copy
            </wa-button>
          </div>
        </wa-dialog>

        <wa-dialog ${ref(this.renameDialogRef)} id="identity-rename-dialog" light-dismiss>
          <div slot="label" class="wa-cluster wa-gap-xs">
            <wa-icon name="pen" variant="solid"></wa-icon>
            Rename DID
          </div>

          <form id="identity-rename-form" class="wa-stack wa-gap-s identity-dialog-body" @submit=${this.onRenameSubmit}>
            <wa-input
              ${ref(this.renameInputRef)}
              id="identity-rename-input"
              label="Enter a new name"
              placeholder="Enter a new identity name"
              .value=${this.renameValue}
              @input=${(event) => {
                this.renameValue = readFieldValue(event.target);
              }}
            ></wa-input>
          </form>

          <div slot="footer" class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer">
            <wa-button appearance="plain" type="button" @click=${this.onCloseRenameDialog}>Cancel</wa-button>
            <wa-button
              id="identity-rename-submit"
              variant="brand"
              type="submit"
              form="identity-rename-form"
              ?loading=${this.isRenameSubmitting}
              ?disabled=${this.isRenameSubmitting || !this.runtime}
            >
              Save
            </wa-button>
          </div>
        </wa-dialog>

        <wa-dialog ${ref(this.deleteDialogRef)} id="identity-delete-dialog">
          <div slot="label" class="wa-cluster wa-gap-xs">
            <wa-icon name="trash" variant="solid"></wa-icon>
            Delete DID
          </div>

          <form id="identity-delete-form" class="wa-stack wa-gap-s identity-dialog-body" @submit=${this.onDeleteConfirmSubmit}>
            <wa-callout variant="danger">
              <div class="identity-delete-callout-copy">
                This will permanently delete your <strong>${this.deleteIdentityLabel || 'identity'}</strong> DID:
              </div>
              <div class="identity-delete-callout-did identity-detail-did">
                <strong>${this.deleteDidUri}</strong>
              </div>
            </wa-callout>

            <div class="wa-caption-m identity-delete-warning">This action cannot be undone.</div>
          </form>

          <div slot="footer" class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer">
            <wa-button appearance="plain" type="button" @click=${this.onCloseDeleteDialog}>Cancel</wa-button>
            <wa-button
              id="identity-delete-submit"
              variant="danger"
              type="submit"
              form="identity-delete-form"
              ?loading=${this.isDeleteSubmitting}
              ?disabled=${this.isDeleteSubmitting || !this.runtime}
            >
              Delete
            </wa-button>
          </div>
        </wa-dialog>

        <wa-dialog ${ref(this.unlockDialogRef)} id="identity-unlock-dialog" light-dismiss>
          <div slot="label" class="wa-cluster wa-gap-xs">
            <wa-icon name="lock-open" variant="solid"></wa-icon>
            Unlock Vault
          </div>

          <form id="identity-unlock-form" class="wa-stack wa-gap-s identity-dialog-body" @submit=${this.onUnlockSubmit}>
            <pin-pad
              ${ref(this.unlockPinPadRef)}
              .value=${this.unlockPassword}
              .disabled=${this.isUnlockSubmitting}
              helper-text="Enter your 4 to 8 digit PIN"
              ?focused=${true}
              min-length="4"
              max-length="8"
              @pin-input=${this.onUnlockPinInput}
              @pin-submit=${this.onUnlockPinSubmit}
            ></pin-pad>
          </form>

          <div slot="footer" class="wa-cluster wa-gap-xs wa-justify-content-end identity-dialog-footer">
            <wa-button appearance="plain" type="button" @click=${this.onCloseUnlockDialog}>Cancel</wa-button>
            <wa-button
              id="identity-unlock-submit"
              variant="brand"
              type="submit"
              form="identity-unlock-form"
              ?loading=${this.isUnlockSubmitting}
              ?disabled=${this.isUnlockSubmitting || !this.runtime || this.unlockPassword.trim().length < 4}
            >
              <wa-icon slot="start" name="lock-open" variant="solid"></wa-icon>
              Unlock
            </wa-button>
          </div>
        </wa-dialog>
      </div>
    `;
  }

  async initializeView() {
    if (!this.runtime) {
      return;
    }

    this.isInitializing = true;
    try {
      const snapshot = await this.runtime.initialize();
      this.applySnapshot(snapshot);
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * @param {IdentityWalletSnapshot} snapshot
   */
  applySnapshot(snapshot) {
    this._lastAppliedSnapshot = snapshot;
    this.pruneState(snapshot.identities);

    if (snapshot.lastError && !shouldSuppressSnapshotWarning(snapshot.lastError, snapshot)) {
      this.showFeedback('warning', snapshot.lastError);
    }
  }

  /**
   * @param {ManagedIdentitySnapshot[]} identities
   */
  pruneState(identities) {
    const didSet = new Set(identities.map((identity) => identity.didUri));

    const nextDetails = new Map(this.detailsByDidUri);
    for (const didUri of Array.from(nextDetails.keys())) {
      if (!didSet.has(didUri)) {
        nextDetails.delete(didUri);
        this._detailsRequestIds.delete(didUri);
      }
    }

    const nextExpanded = new Set(this.expandedDidUris);
    for (const didUri of Array.from(nextExpanded.values())) {
      if (!didSet.has(didUri)) {
        nextExpanded.delete(didUri);
      }
    }

    this.detailsByDidUri = nextDetails;
    this.expandedDidUris = nextExpanded;
  }

  syncAccordionItems() {
    const accordion = this.accordionRef.value;
    if (!(accordion instanceof HTMLElement)) {
      return;
    }

    const castAccordion = /** @type {HTMLElement & { items?: unknown; emptyText?: string; ariaLabel?: string }} */ (accordion);
    castAccordion.emptyText = 'No identities yet.';
    castAccordion.ariaLabel = 'Managed DIDs';

    if (!this.snapshot || this.snapshot.isLocked) {
      castAccordion.items = [];
      return;
    }

    castAccordion.items = this.identities.map((identity) => this.toAccordionItem(identity));
  }

  /**
   * @param {ManagedIdentitySnapshot} identity
   */
  toAccordionItem(identity) {
    const detailsState = this.detailsByDidUri.get(identity.didUri);
    const isActive = this.isIdentityActive(identity);
    const encodedDid = encodeDidUri(identity.didUri);

    return {
      id: identity.didUri,
      title: identity.name || 'Identity',
      subtitle: identity.didUri,
      avatarHash: identity.didUri,
      avatarFallback: identity.name || identity.didUri,
      open: this.expandedDidUris.has(identity.didUri),
      summaryLeadingHtml: `
        <span class="identity-accordion-radio">
          <input
            class="identity-accordion-radio-input"
            type="radio"
            name="identity-active-did"
            data-action="switch"
            data-did-uri="${encodedDid}"
            aria-label="${escapeHtml(`Set ${identity.name || identity.didUri} as active DID`)}"
            ${isActive ? 'checked disabled' : ''}
          >
        </span>
      `,
      panelHtml: this.renderIdentityPanelHtml(identity, detailsState),
    };
  }

  /**
   * @param {ManagedIdentitySnapshot} identity
   * @param {ManagedDidDetailsState | undefined} detailsState
   */
  renderIdentityPanelHtml(identity, detailsState) {
    const encodedDid = encodeDidUri(identity.didUri);

    return `
      <div class="identity-accordion-panel">
        <div class="identity-item-actions">
          <wa-button size="small" appearance="outlined" data-action="export" data-did-uri="${encodedDid}">
            <wa-icon slot="start" name="download" variant="solid"></wa-icon>
            Export
          </wa-button>
          <wa-button size="small" appearance="outlined" data-action="rename" data-did-uri="${encodedDid}">
            <wa-icon slot="start" name="pen" variant="solid"></wa-icon>
            Rename
          </wa-button>
          <wa-button size="small" variant="danger" appearance="outlined" data-action="delete" data-did-uri="${encodedDid}">
            <wa-icon slot="start" name="trash" variant="solid"></wa-icon>
            Delete
          </wa-button>
        </div>

        ${this.renderDetailsStateMarkup(identity, detailsState)}
      </div>
    `;
  }

  /**
   * @param {ManagedIdentitySnapshot} identity
   * @param {ManagedDidDetailsState | undefined} detailsState
   */
  renderDetailsStateMarkup(identity, detailsState) {
    const encodedDid = encodeDidUri(identity.didUri);

    if (!detailsState) {
      return `
        <div class="identity-details-loading">
          <div class="wa-caption-s">Expand to load DID details.</div>
        </div>
      `;
    }

    if (detailsState.status === 'loading') {
      return `
        <div class="wa-stack wa-align-items-center wa-gap-s identity-details-loading">
          <wa-spinner style="font-size: 1.4rem"></wa-spinner>
          <div class="wa-caption-s">Loading DID details...</div>
        </div>
      `;
    }

    if (detailsState.status === 'error') {
      return `
        <wa-callout variant="danger">
          <div class="wa-stack wa-gap-s">
            <div class="wa-caption-s">Failed to load DID details.</div>
            <div class="identity-detail-did">${escapeHtml(detailsState.message)}</div>
            <div class="wa-cluster wa-gap-xs">
              <wa-button size="small" appearance="outlined" data-action="reload-details" data-did-uri="${encodedDid}">
                <wa-icon slot="start" name="arrow-rotate-right" variant="solid"></wa-icon>
                Retry
              </wa-button>
            </div>
          </div>
        </wa-callout>
      `;
    }

    const details = detailsState.details;
    const connectedResolutionJson = details.connectedDidResolution
      ? escapeHtml(JSON.stringify(details.connectedDidResolution, null, 2))
      : '';
    const endpointsValue = escapeHtml(details.dwnEndpoints.join('\n'));
    const identifierValue = details.identity.connectedTargetDid || details.identity.didUri;
    const escapedIdentifierValue = escapeHtml(identifierValue);
    const connectedDidValue = details.identity.connectedDid ? escapeHtml(details.identity.connectedDid) : '';

    return `
      <div class="wa-stack wa-gap-s">
        <div class="wa-stack wa-gap-2xs">
          <div class="wa-caption-s">Identity Name</div>
          <div class="identity-detail-value">${escapeHtml(details.identity.name || 'Identity')}</div>
        </div>

        <div class="wa-stack wa-gap-2xs">
          <div class="wa-caption-s">Identifier</div>
          <div class="identity-detail-inline">
            <div class="identity-detail-value identity-detail-did" title="${escapedIdentifierValue}">${escapedIdentifierValue}</div>
            <wa-copy-button
              value="${escapedIdentifierValue}"
              copy-label="Copy identifier"
              success-label="Identifier copied"
              error-label="Copy failed"
            ></wa-copy-button>
          </div>
        </div>

        ${connectedDidValue
          ? `
            <div class="wa-stack wa-gap-2xs">
              <div class="wa-caption-s">Connected DID</div>
              <div class="identity-detail-value identity-detail-did" title="${connectedDidValue}">${connectedDidValue}</div>
            </div>
          `
          : ''}

        <div class="wa-stack wa-gap-2xs">
          <div class="wa-caption-s">DWN Endpoints</div>
          <wa-textarea
            class="identity-details-endpoints-input"
            data-did-uri="${encodedDid}"
            rows="4"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
          >${endpointsValue}</wa-textarea>
          <div class="wa-cluster wa-gap-xs">
            <wa-button size="small" variant="brand" appearance="outlined" data-action="save-endpoints" data-did-uri="${encodedDid}">
              <wa-icon slot="start" name="floppy-disk" variant="solid"></wa-icon>
              Save Endpoints
            </wa-button>
          </div>
        </div>

        ${connectedResolutionJson
          ? `
            <wa-details>
              <div slot="summary" class="wa-caption-s">Connected DID Resolution</div>
              <x-code language="json">${connectedResolutionJson}</x-code>
            </wa-details>
          `
          : ''}
      </div>
    `;
  }

  onRefresh = async () => {
    if (!this.runtime || this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    try {
      const snapshot = await this.runtime.refresh();
      this.applySnapshot(snapshot);
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isRefreshing = false;
    }
  };

  onVaultTogglePressed = async () => {
    if (!this.runtime || !this.snapshot || this.isVaultToggling) {
      return;
    }

    if (this.isUninitializedVault) {
      this.showFeedback('brand', 'Create or import a DID to initialize this vault.');
      return;
    }

    if (this.snapshot.isLocked) {
      this.openUnlockDialog();
      return;
    }

    this.isVaultToggling = true;
    try {
      const snapshot = await this.runtime.lock();
      this.applySnapshot(snapshot);
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isVaultToggling = false;
    }
  };

  onCloseRecoveryDialog = () => {
    this.recoveryPhraseDidUri = '';
    this.closeDialog(this.recoveryDialogRef.value);
  };

  onCopyRecoveryPhrase = async () => {
    const phrase = this.latestRecoveryPhrase;
    if (!phrase) {
      this.showFeedback('warning', 'No recovery phrase is currently available.');
      return;
    }

    if (!navigator?.clipboard?.writeText) {
      this.showFeedback('danger', 'Clipboard access is unavailable.');
      return;
    }

    try {
      await navigator.clipboard.writeText(phrase);
      this.onCloseRecoveryDialog();
      this.showFeedback('success', 'Phrase copied.', { allowSuccess: true });
    } catch (error) {
      this.showFeedback('danger', `Copy failed: ${errorMessage(error)}`);
    }
  };

  onOpenToolbarCreateDialog = () => {
    if (this.snapshot?.isLocked) {
      this.showFeedback('warning', 'Unlock the vault before creating another DID.');
      this.openUnlockDialog();
      return;
    }

    void this.openCreateDialog('additional');
  };

  onOpenInitialCreateDialog = () => {
    const mode = this.isUninitializedVault
      ? 'initial'
      : this.snapshot?.isLocked
      ? 'unlock'
      : 'additional';

    void this.openCreateDialog(mode);
  };

  onCloseCreateDialog = () => {
    this.resetCreateWizard();
    this.closeDialog(this.createDialogRef.value);
  };

  /**
   * @param {CustomEvent<CreateWizardFooterState>} event
   */
  onCreateWizardStateChanged = (event) => {
    this.createWizardFooterState = normalizeCreateWizardFooterState(event.detail);
  };

  onCreateWizardPrimaryAction = () => {
    if (this.isCreateSubmitting) {
      return;
    }

    this.createWizardRef.value?.requestPrimaryAction?.();
  };

  onCreateWizardBackAction = () => {
    if (this.isCreateSubmitting) {
      return;
    }

    this.createWizardRef.value?.requestBackAction?.();
  };

  onOpenImportDialog = () => {
    this.importMode = 'phrase';
    this.openDialog(this.importDialogRef.value);
  };

  onOpenToolbarRecoveryDialog = () => {
    this.openRecoveryDialog(this.activeManagedDidUri || '');
  };

  onCloseImportDialog = () => {
    this.closeDialog(this.importDialogRef.value);
  };

  onOpenUnlockDialog = () => {
    this.openUnlockDialog();
  };

  onCloseUnlockDialog = () => {
    this.closeDialog(this.unlockDialogRef.value);
  };

  onCloseRenameDialog = () => {
    this.renameDidUri = '';
    this.renameValue = '';
    this.closeDialog(this.renameDialogRef.value);
  };

  onCloseDeleteDialog = () => {
    this.deleteDidUri = '';
    this.closeDialog(this.deleteDialogRef.value);
  };

  /**
   * @param {Event} event
   */
  onImportModeChanged = (event) => {
    const mode = readFieldValue(event.target);
    this.importMode = mode === 'upload' ? 'upload' : 'phrase';
  };

  /**
   * @param {SubmitEvent} event
   */
  onCreateWizardSubmit = async (event) => {
    const detail = event.detail ?? {};
    if (!this.runtime || this.isCreateSubmitting) {
      return;
    }

    const name = typeof detail.name === 'string' ? detail.name.trim() : '';
    const password = typeof detail.password === 'string' ? detail.password.trim() : '';
    const dwnEndpoints = Array.isArray(detail.dwnEndpoints)
      ? detail.dwnEndpoints.filter((endpoint) => typeof endpoint === 'string' && endpoint.trim().length > 0)
      : [];

    if (!name) {
      this.showFeedback('danger', 'Identity name is required.');
      return;
    }

    if (this.createWizardMode === 'additional' && this.snapshot?.isLocked) {
      this.showFeedback('warning', 'Unlock the vault before creating another DID.');
      this.openUnlockDialog();
      return;
    }

    this.isCreateSubmitting = true;
    try {
      const snapshot = await this.runtime.createDid({
        name,
        password: password || undefined,
        dwnEndpoints,
      });

      this.createWizardMode = 'additional';
      this.resetCreateWizard();
      this.closeDialog(this.createDialogRef.value);
      this.applySnapshot(snapshot);

      const selectedDid = this.getPreferredDid(snapshot);
      if (selectedDid) {
        await this.expandAndLoadDid(selectedDid, true);
      }
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isCreateSubmitting = false;
    }
  };

  /**
   * @param {SubmitEvent} event
   */
  onPhraseImportSubmit = async (event) => {
    event.preventDefault();
    if (!this.runtime || this.isPhraseSubmitting) {
      return;
    }

    const recoveryPhrase = this.phraseValue.trim();
    const password = this.phrasePassword.trim();

    if (!recoveryPhrase || !password) {
      this.showFeedback('danger', 'Recovery phrase and vault PIN or password are required.');
      return;
    }

    this.isPhraseSubmitting = true;
    try {
      const snapshot = await this.runtime.importFromPhrase({
        recoveryPhrase,
        password,
        dwnEndpoints: parseEndpointText(this.phraseEndpoints),
      });

      this.phrasePassword = '';
      this.closeDialog(this.importDialogRef.value);
      this.applySnapshot(snapshot);

      const selectedDid = this.getPreferredDid(snapshot);
      if (selectedDid) {
        await this.expandAndLoadDid(selectedDid, true);
      }
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isPhraseSubmitting = false;
    }
  };

  /**
   * @param {SubmitEvent} event
   */
  onPortableImportSubmit = async (event) => {
    event.preventDefault();
    if (!this.runtime || this.isPortableSubmitting) {
      return;
    }

    const rawJson = this.portableJson.trim();
    if (!rawJson) {
      this.showFeedback('danger', 'PortableIdentity JSON is required.');
      return;
    }

    /** @type {Record<string, unknown>} */
    let portableIdentity;
    try {
      portableIdentity = JSON.parse(rawJson);
    } catch (error) {
      this.showFeedback('danger', `Invalid JSON: ${errorMessage(error)}`);
      return;
    }

    this.isPortableSubmitting = true;
    try {
      const snapshot = await this.runtime.importFromPortable({
        portableIdentity,
        password: this.portablePassword.trim(),
        dwnEndpoints: parseEndpointText(this.portableEndpoints),
      });

      this.portablePassword = '';
      this.closeDialog(this.importDialogRef.value);
      this.applySnapshot(snapshot);

      const selectedDid = this.getPreferredDid(snapshot);
      if (selectedDid) {
        await this.expandAndLoadDid(selectedDid, true);
      }
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isPortableSubmitting = false;
    }
  };

  /**
   * @param {SubmitEvent} event
   */
  onUnlockSubmit = async (event) => {
    event.preventDefault();
    if (!this.runtime || this.isUnlockSubmitting) {
      return;
    }

    const password = this.unlockPassword.trim();
    if (!password) {
      this.showFeedback('danger', 'Enter your vault PIN to unlock.');
      return;
    }

    this.isUnlockSubmitting = true;
    try {
      const snapshot = await this.runtime.unlock(password);
      this.unlockPassword = '';
      this.closeDialog(this.unlockDialogRef.value);
      this.applySnapshot(snapshot);

      const selectedDid = this.getPreferredDid(snapshot);
      if (selectedDid) {
        await this.expandAndLoadDid(selectedDid, false);
      }
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isUnlockSubmitting = false;
    }
  };

  /**
   * @param {CustomEvent<{ value?: string }>} event
   */
  onUnlockPinInput = (event) => {
    const value = event.detail?.value;
    this.unlockPassword = typeof value === 'string' ? value : '';
  };

  /**
   * @param {CustomEvent<{ value?: string }>} event
   */
  onUnlockPinSubmit = (event) => {
    if (this.isUnlockSubmitting || !this.runtime) {
      return;
    }

    const value = event.detail?.value;
    const pin = typeof value === 'string' ? value.trim() : this.unlockPassword.trim();
    if (pin.length < 4) {
      return;
    }

    const dialog = this.unlockDialogRef.value;
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    const form = dialog.querySelector('form');
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  };

  /**
   * @param {SubmitEvent} event
   */
  onRenameSubmit = async (event) => {
    event.preventDefault();
    if (!this.runtime || this.isRenameSubmitting) {
      return;
    }

    const didUri = this.renameDidUri.trim();
    const nextName = this.renameValue.trim();
    if (!didUri) {
      return;
    }

    if (!nextName) {
      this.showFeedback('danger', 'Enter a new identity name.');
      return;
    }

    const existing = this.identities.find((identity) => identity.didUri === didUri);
    if (existing && nextName === existing.name) {
      this.onCloseRenameDialog();
      return;
    }

    this.isRenameSubmitting = true;
    try {
      const snapshot = await this.runtime.renameDid({ didUri, name: nextName });
      const nextDetails = new Map(this.detailsByDidUri);
      nextDetails.delete(didUri);
      this.detailsByDidUri = nextDetails;
      this.applySnapshot(snapshot);

      this.onCloseRenameDialog();
      if (this.expandedDidUris.has(didUri)) {
        await this.ensureDidDetailsLoaded(didUri, { force: true });
      }

      this.showFeedback('success', `Renamed ${didUri}.`, { allowSuccess: true });
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isRenameSubmitting = false;
    }
  };

  /**
   * @param {SubmitEvent} event
   */
  onDeleteConfirmSubmit = async (event) => {
    event.preventDefault();
    if (!this.runtime || this.isDeleteSubmitting) {
      return;
    }

    const didUri = this.deleteDidUri.trim();
    if (!didUri) {
      return;
    }

    this.isDeleteSubmitting = true;
    try {
      const snapshot = await this.runtime.deleteDid({ didUri });

      const nextExpanded = new Set(this.expandedDidUris);
      nextExpanded.delete(didUri);
      this.expandedDidUris = nextExpanded;

      const nextDetails = new Map(this.detailsByDidUri);
      nextDetails.delete(didUri);
      this.detailsByDidUri = nextDetails;
      this._detailsRequestIds.delete(didUri);

      this.applySnapshot(snapshot);
      this.onCloseDeleteDialog();
      this.showFeedback('success', `Deleted ${didUri}.`, { allowSuccess: true });
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      this.isDeleteSubmitting = false;
    }
  };

  /**
   * @param {CustomEvent<{ actionElement?: unknown }>} event
   */
  onAccordionAction = (event) => {
    const actionElementFromDetail = event.detail?.actionElement;
    if (actionElementFromDetail instanceof HTMLElement) {
      void this.handleListAction(actionElementFromDetail);
      return;
    }

    const actionElementFromPath = findActionElementInEvent(event);
    if (actionElementFromPath instanceof HTMLElement) {
      void this.handleListAction(actionElementFromPath);
      return;
    }

    const action = typeof event.detail?.action === 'string' ? event.detail.action : '';
    const encodedDid = typeof event.detail?.didUri === 'string' ? event.detail.didUri : '';
    if (!action || !encodedDid) {
      return;
    }

    const syntheticActionButton = document.createElement('button');
    syntheticActionButton.dataset.action = action;
    syntheticActionButton.dataset.didUri = encodedDid;
    void this.handleListAction(syntheticActionButton);
  };

  /**
   * @param {Event} event
   */
  onAccordionShow = (event) => {
    const didUri = didUriFromAccordionEvent(event);
    if (!didUri) {
      return;
    }

    const nextExpanded = new Set(this.expandedDidUris);
    nextExpanded.add(didUri);
    this.expandedDidUris = nextExpanded;
    void this.ensureDidDetailsLoaded(didUri);
  };

  /**
   * @param {Event} event
   */
  onAccordionHide = (event) => {
    const didUri = didUriFromAccordionEvent(event);
    if (!didUri) {
      return;
    }

    const nextExpanded = new Set(this.expandedDidUris);
    nextExpanded.delete(didUri);
    this.expandedDidUris = nextExpanded;
  };

  /**
   * @param {Event} event
   */
  onAccordionToggle = (event) => {
    const didUri = didUriFromAccordionEvent(event);
    if (!didUri) {
      return;
    }

    const detail = event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
      ? /** @type {{ open?: unknown }} */ (event.detail)
      : null;
    const isOpen = typeof detail?.open === 'boolean'
      ? detail.open
      : event.target instanceof HTMLElement && event.target.hasAttribute('open');

    const nextExpanded = new Set(this.expandedDidUris);
    if (isOpen) {
      nextExpanded.add(didUri);
      this.expandedDidUris = nextExpanded;
      void this.ensureDidDetailsLoaded(didUri);
      return;
    }

    nextExpanded.delete(didUri);
    this.expandedDidUris = nextExpanded;
  };

  /**
   * @param {HTMLElement} actionButton
   */
  async handleListAction(actionButton) {
    if (!this.runtime) {
      return;
    }

    const action = actionButton.dataset.action ?? '';
    const encodedDid = actionButton.dataset.didUri ?? '';
    const didUri = decodeDidUri(encodedDid);
    if (!didUri) {
      return;
    }

    if (action === 'rename') {
      this.openRenameDialog(didUri);
      return;
    }

    if (action === 'delete') {
      this.openDeleteDialog(didUri);
      return;
    }

    await this.withBusyButton(actionButton, async () => {
      if (action === 'switch') {
        if (didUri === this.activeManagedDidUri) {
          return;
        }

        const previousActiveDid = this.activeManagedDidUri;
        const result = await switchDidWithToast({
          runtime : this.runtime,
          didUri,
          previousActiveDid,
          toastStore : this.appStore?.toast ?? getAppStore().toast,
        });

        if (result.snapshot) {
          this.applySnapshot(result.snapshot);
        }
        return;
      }

      if (action === 'export') {
        const exported = await this.runtime.exportDid(didUri);
        const fileName = downloadExport(exported);
        this.showFeedback('success', `Exported ${didUri} as ${fileName}.`, { allowSuccess: true });
        return;
      }

      if (action === 'save-endpoints') {
        const endpointInput = this.findDetailsEndpointInput(actionButton, encodedDid);
        if (!(endpointInput instanceof HTMLElement)) {
          throw new Error('Unable to locate endpoint editor for this DID.');
        }

        const endpoints = parseEndpointText(readFieldValue(endpointInput));
        if (endpoints.length === 0) {
          throw new Error('At least one endpoint is required.');
        }

        const snapshot = await this.runtime.setDidEndpoints({ didUri, endpoints });
        const nextDetails = new Map(this.detailsByDidUri);
        nextDetails.delete(didUri);
        this.detailsByDidUri = nextDetails;

        this.applySnapshot(snapshot);
        await this.ensureDidDetailsLoaded(didUri, { force: true });
        return;
      }

      if (action === 'reload-details') {
        await this.ensureDidDetailsLoaded(didUri, { force: true });
      }
    });
  }

  /**
   * @param {HTMLElement} actionButton
   * @param {string} encodedDid
   */
  findDetailsEndpointInput(actionButton, encodedDid) {
    const selector = `.identity-details-endpoints-input[data-did-uri="${cssAttributeEscape(encodedDid)}"]`;

    const actionRoot = actionButton.getRootNode();
    if (actionRoot && typeof actionRoot === 'object' && 'querySelector' in actionRoot) {
      const candidate = actionRoot.querySelector(selector);
      if (candidate instanceof HTMLElement) {
        return candidate;
      }
    }

    const accordion = this.accordionRef.value;
    if (!(accordion instanceof HTMLElement)) {
      return null;
    }

    const lightDomCandidate = accordion.querySelector(selector);
    if (lightDomCandidate instanceof HTMLElement) {
      return lightDomCandidate;
    }

    const shadowDomCandidate = accordion.shadowRoot?.querySelector(selector);
    if (shadowDomCandidate instanceof HTMLElement) {
      return shadowDomCandidate;
    }

    return null;
  }

  /**
   * @param {string} didUri
   * @param {{ force?: boolean }=} options
   */
  async ensureDidDetailsLoaded(didUri, options = {}) {
    if (!this.runtime || !didUri) {
      return;
    }

    const state = this.detailsByDidUri.get(didUri);
    if (!options.force && (state?.status === 'loaded' || state?.status === 'loading')) {
      return;
    }

    const requestId = this._detailsRequestCounter + 1;
    this._detailsRequestCounter = requestId;
    this._detailsRequestIds.set(didUri, requestId);

    const loadingState = new Map(this.detailsByDidUri);
    loadingState.set(didUri, { status: 'loading' });
    this.detailsByDidUri = loadingState;

    try {
      const details = await this.runtime.getDidDetails(didUri);
      if (this._detailsRequestIds.get(didUri) !== requestId) {
        return;
      }

      const loadedState = new Map(this.detailsByDidUri);
      loadedState.set(didUri, {
        status: 'loaded',
        details,
      });
      this.detailsByDidUri = loadedState;
    } catch (error) {
      if (this._detailsRequestIds.get(didUri) !== requestId) {
        return;
      }

      const nextState = new Map(this.detailsByDidUri);
      nextState.set(didUri, {
        status: 'error',
        message: errorMessage(error),
      });
      this.detailsByDidUri = nextState;
      this.showFeedback('danger', `Failed to load DID details: ${errorMessage(error)}`);
    }
  }

  /**
   * @param {string} didUri
   * @param {boolean} force
   */
  async expandAndLoadDid(didUri, force) {
    const nextExpanded = new Set(this.expandedDidUris);
    nextExpanded.add(didUri);
    this.expandedDidUris = nextExpanded;
    await this.ensureDidDetailsLoaded(didUri, { force });
  }

  /**
   * @param {IdentityWalletSnapshot} snapshot
   */
  getPreferredDid(snapshot) {
    return snapshot.activeManagedDidUri ?? snapshot.identities[0]?.didUri ?? '';
  }

  /**
   * @param {ManagedIdentitySnapshot} identity
   * @returns {boolean}
   */
  isIdentityActive(identity) {
    const activeDid = this.activeManagedDidUri;
    if (activeDid) {
      return activeDid === identity.didUri;
    }

    return identity.active;
  }

  syncCreateWizardFooterState() {
    const wizard = this.createWizardRef.value;
    if (wizard && typeof wizard.getFooterState === 'function') {
      this.createWizardFooterState = normalizeCreateWizardFooterState(wizard.getFooterState());
      return;
    }

    this.createWizardFooterState = defaultCreateWizardFooterState();
  }

  resetCreateWizard(mode = this.createWizardMode) {
    const wizard = this.createWizardRef.value;
    if (wizard && typeof wizard.reset === 'function') {
      wizard.reset({ mode });
    }

    this.syncCreateWizardFooterState();
  }

  async openCreateDialog(mode) {
    this.createWizardMode = mode;
    await this.updateComplete;
    this.resetCreateWizard(mode);

    const dialog = this.createDialogRef.value;
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    let focused = false;
    const focusWhenReady = () => {
      if (focused) {
        return;
      }

      focused = true;
      this.createWizardRef.value?.focusPrimaryField?.();
    };

    dialog.addEventListener('wa-after-show', focusWhenReady, { once: true });
    dialog.addEventListener('wa-show', focusWhenReady, { once: true });
    this.openDialog(dialog);
    window.setTimeout(focusWhenReady, 140);
  }

  openUnlockDialog() {
    const dialog = this.unlockDialogRef.value;
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    let focused = false;
    const focusWhenReady = () => {
      if (focused) {
        return;
      }

      focused = true;
      this.unlockPinPadRef.value?.focusPrimaryKey?.();
    };

    dialog.addEventListener('wa-after-show', focusWhenReady, { once: true });
    dialog.addEventListener('wa-show', focusWhenReady, { once: true });
    this.openDialog(dialog);
    window.setTimeout(focusWhenReady, 140);
  }

  openRecoveryDialog(didUri = '') {
    if (this.snapshot?.isLocked) {
      this.showFeedback('warning', 'Unlock the vault before viewing the recovery phrase.');
      return;
    }

    if (!this.latestRecoveryPhrase) {
      this.showFeedback('warning', 'No recovery phrase is currently available.');
      return;
    }

    this.recoveryPhraseDidUri = didUri;
    this.openDialog(this.recoveryDialogRef.value);
  }

  openRenameDialog(didUri) {
    const identity = this.identities.find((entry) => entry.didUri === didUri);
    if (!identity) {
      return;
    }

    this.renameDidUri = didUri;
    this.renameValue = identity.name ?? '';

    const dialog = this.renameDialogRef.value;
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    let focused = false;
    const focusWhenReady = () => {
      if (focused) {
        return;
      }

      focused = true;
      focusFieldSoon(this.renameInputRef.value);
    };

    dialog.addEventListener('wa-after-show', focusWhenReady, { once: true });
    dialog.addEventListener('wa-show', focusWhenReady, { once: true });
    this.openDialog(dialog);
    window.setTimeout(focusWhenReady, 140);
  }

  openDeleteDialog(didUri) {
    this.deleteDidUri = didUri;
    this.openDialog(this.deleteDialogRef.value);
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

  /**
   * @param {HTMLElement | null | undefined} dialog
   */
  closeDialog(dialog) {
    if (!(dialog instanceof HTMLElement)) {
      return;
    }

    const hide = /** @type {{ hide?: () => Promise<void> | void }} */ (dialog).hide;
    if (typeof hide === 'function') {
      void hide.call(dialog);
      return;
    }

    dialog.removeAttribute('open');
  }

  /**
   * @param {HTMLElement | null} button
   * @param {() => Promise<void>} action
   */
  async withBusyButton(button, action) {
    if (button instanceof HTMLElement) {
      button.setAttribute('loading', '');
      button.setAttribute('disabled', '');
    }

    try {
      await action();
    } catch (error) {
      this.showFeedback('danger', errorMessage(error));
    } finally {
      if (button instanceof HTMLElement) {
        button.removeAttribute('loading');
        button.removeAttribute('disabled');
      }
    }
  }

  /**
   * @param {string} tone
   * @param {string} message
   * @param {{ allowSuccess?: boolean }=} options
   */
  showFeedback(tone, message, options = {}) {
    const trimmedMessage = String(message).trim();
    if (trimmedMessage.length === 0) {
      return;
    }

    const toastTone = normalizeFeedbackTone(tone);
    if (toastTone === 'success' && !options.allowSuccess) {
      return;
    }

    if (isUnlockNoiseMessage(trimmedMessage)) {
      return;
    }

    const toastStore = this.appStore?.toast ?? getAppStore().toast;
    toastStore.notify({
      tone: toastTone,
      message: trimmedMessage,
      dedupeWindowMs: 1200,
      allowDuplicate: false,
    });
  }
}

if (!customElements.get('identity-page')) {
  customElements.define('identity-page', IdentityPage);
}

/**
 * @param {Event} event
 * @returns {string}
 */
function didUriFromAccordionEvent(event) {
  if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
    const itemId = /** @type {{ itemId?: unknown }} */ (event.detail).itemId;
    if (typeof itemId === 'string' && itemId.length > 0) {
      return itemId;
    }
  }

  if (typeof event.composedPath === 'function') {
    for (const pathNode of event.composedPath()) {
      if (!(pathNode instanceof HTMLElement)) {
        continue;
      }

      if (pathNode.matches('wa-details.item') && typeof pathNode.dataset.itemId === 'string') {
        return pathNode.dataset.itemId;
      }
    }
  }

  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches('wa-details.item') || typeof target.dataset.itemId !== 'string') {
    return '';
  }

  return target.dataset.itemId;
}

/**
 * @param {Event} event
 * @returns {HTMLElement | null}
 */
function findActionElementInEvent(event) {
  if (typeof event.composedPath !== 'function') {
    return null;
  }

  for (const pathNode of event.composedPath()) {
    if (!(pathNode instanceof HTMLElement)) {
      continue;
    }

    if (pathNode.matches('[data-action]')) {
      return pathNode;
    }
  }

  return null;
}

/**
 * @param {string} message
 * @param {IdentityWalletSnapshot} snapshot
 * @returns {boolean}
 */
function shouldSuppressSnapshotWarning(message, snapshot) {
  if (isUnlockNoiseMessage(message)) {
    return true;
  }

  if (!snapshot.isLocked) {
    return false;
  }

  const normalized = message.trim().toLowerCase();
  return normalized.startsWith('vault is locked');
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isUnlockNoiseMessage(message) {
  const normalized = message.trim().toLowerCase();
  return normalized.includes('vault is unlocked')
    || normalized.includes('vault unlocked')
    || normalized.includes('already unlocked');
}

/**
 * @param {string} tone
 * @returns {'neutral' | 'brand' | 'success' | 'warning' | 'danger'}
 */
function normalizeFeedbackTone(tone) {
  if (tone === 'brand' || tone === 'success' || tone === 'warning' || tone === 'danger') {
    return tone;
  }

  return 'neutral';
}

/**
 * @param {string} rawDidUri
 * @returns {string}
 */
function encodeDidUri(rawDidUri) {
  return encodeURIComponent(rawDidUri);
}

/**
 * @param {string} encodedDidUri
 * @returns {string}
 */
function decodeDidUri(encodedDidUri) {
  try {
    return decodeURIComponent(encodedDidUri);
  } catch {
    return '';
  }
}

/**
 * @param {unknown} target
 * @returns {string}
 */
function readFieldValue(target) {
  if (!target || typeof target !== 'object') {
    return '';
  }

  const value = /** @type {{ value?: unknown }} */ (target).value;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function parseEndpointText(value) {
  return Array.from(new Set(
    value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ));
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {string} value
 * @returns {string}
 */
function cssAttributeEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }

  return value.replaceAll('"', '\\"');
}

/**
 * @param {ExportedIdentity} exported
 * @returns {string}
 */
function downloadExport(exported) {
  const safeDid = exported.didUri.replaceAll(':', '_');
  const fileName = `${safeDid}.portable-identity.json`;
  const blob = new Blob([exported.json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return fileName;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/**
 * @param {HTMLElement | null | undefined} field
 */
function focusFieldSoon(field) {
  if (!(field instanceof HTMLElement)) {
    return;
  }

  const tryFocus = () => {
    const control = /** @type {{ focus?: () => void; setFocus?: () => Promise<void> | void }} */ (field);
    if (typeof control.setFocus === 'function') {
      void control.setFocus();
      return;
    }

    const focus = /** @type {{ focus?: () => void }} */ (field).focus;
    if (typeof focus === 'function') {
      focus.call(field);
    }
  };

  queueMicrotask(() => {
    tryFocus();
    window.requestAnimationFrame(() => tryFocus());
    window.setTimeout(() => tryFocus(), 100);
  });
}
