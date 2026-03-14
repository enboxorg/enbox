import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { appContext } from '../../state/app-context.js';
import './index.css';

const resolverRuntimeWindowKey = '__didResolverRuntime';

/** @typedef {'idle' | 'resolving' | 'unsupported' | 'error' | 'resolved'} ResolverStatus */

/**
 * @typedef DidResolutionResultState
 * @property {Record<string, unknown> | null | undefined} didDocument
 * @property {Record<string, unknown>} didResolutionMetadata
 * @property {Record<string, unknown>} didDocumentMetadata
 */

class ResolverPage extends SignalWatcher(LitElement) {
  static properties = {
    currentDid: { state: true },
    status: { state: true },
    errorMessage: { state: true },
    unsupportedMethod: { state: true },
    resolutionResult: { state: true },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.currentDid = '';
    /** @type {ResolverStatus} */
    this.status = 'idle';
    this.errorMessage = '';
    this.unsupportedMethod = '';
    /** @type {DidResolutionResultState | null} */
    this.resolutionResult = null;

    this.appStore = null;
    this._activeResolutionId = 0;
    this._observedResolverDid = '';
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  updated() {
    const selectedDid = this.selectedDid;
    if (selectedDid === this._observedResolverDid) {
      return;
    }

    this._observedResolverDid = selectedDid;
    if (selectedDid.length === 0) {
      this.currentDid = '';
      this.status = 'idle';
      this.errorMessage = '';
      this.unsupportedMethod = '';
      this.resolutionResult = null;
      return;
    }

    void this.resolveDid(selectedDid);
  }

  get selectedDid() {
    return this.appStore?.resolver.currentDid.get() ?? '';
  }

  get titleText() {
    return this.selectedDid || this.currentDid || 'No DID selected';
  }

  render() {
    return html`
      <div class="wa-stack wa-gap-xl dashboard page-block">
        <section class="wa-stack">
          <div class="wa-stack wa-gap-2xs resolver-did-header">
            <div class="resolver-did-title">${this.titleText}</div>
          </div>

          <div class="wa-stack wa-gap-l">
            ${this.renderContent()}
          </div>
        </section>
      </div>
    `;
  }

  renderContent() {
    if (this.status === 'idle') {
      return html`
        <wa-callout appearance="accent">
          Enter a DID in the global search input to resolve it.
        </wa-callout>
      `;
    }

    if (this.status === 'resolving') {
      return html`
        <div class="wa-stack wa-align-items-center wa-gap-s" style="padding: var(--wa-space-2xl) 0;">
          <wa-spinner style="font-size: 2rem"></wa-spinner>
          <div class="wa-caption-m">resolving</div>
          <div class="wa-caption-s" style="word-break: break-all;">${this.currentDid}</div>
        </div>
      `;
    }

    if (this.status === 'unsupported') {
      return html`
        <wa-callout variant="danger">
          Cannot resolve DIDs of the type ${this.unsupportedMethod}
        </wa-callout>
      `;
    }

    if (this.status === 'error') {
      return html`
        <wa-callout variant="danger">
          ${this.errorMessage || 'An unknown error occurred while resolving this DID.'}
        </wa-callout>
      `;
    }

    if (this.status !== 'resolved' || !this.resolutionResult) {
      return html``;
    }

    const didResolutionMetadata = this.resolutionResult.didResolutionMetadata ?? {};
    const didDocumentMetadata = this.resolutionResult.didDocumentMetadata ?? {};
    const didDocument = this.resolutionResult.didDocument;

    const isResolutionError = typeof didResolutionMetadata.error === 'string'
      || !didDocument
      || typeof didDocument !== 'object';
    const resolutionErrorMessage = typeof didResolutionMetadata.message === 'string'
      ? didResolutionMetadata.message
      : 'An error occurred while resolving this DID.';

    const resolutionMetadata = {
      didResolutionMetadata,
      didDocumentMetadata,
    };

    return html`
      <wa-tab-group activation="auto">
        <wa-tab slot="nav" panel="did-document">DID Document</wa-tab>
        <wa-tab slot="nav" panel="resolution-metadata">Resolution Metadata</wa-tab>

        <wa-tab-panel name="did-document">
          ${isResolutionError
            ? html`<wa-callout variant="danger">${resolutionErrorMessage}</wa-callout>`
            : html`<x-code class="resolver-json-output" language="json">${formatJson(didDocument)}</x-code>`}
        </wa-tab-panel>

        <wa-tab-panel name="resolution-metadata">
          <x-code class="resolver-json-output" language="json">${formatJson(resolutionMetadata)}</x-code>
        </wa-tab-panel>
      </wa-tab-group>
    `;
  }

  /**
   * @param {string} did
   */
  setCurrentDid(did) {
    this.currentDid = did;
  }

  /**
   * @param {string} did
   * @returns {Promise<void>}
   */
  async resolveDid(did) {
    const didResolverRuntime = getDidResolverRuntime();
    if (!didResolverRuntime) {
      this.status = 'error';
      this.errorMessage = 'DID resolver runtime is unavailable.';
      return;
    }

    const normalizedDid = did.trim();
    if (normalizedDid.length === 0) {
      this.status = 'idle';
      this.currentDid = '';
      return;
    }

    this.setCurrentDid(normalizedDid);

    const methodPrefix = didResolverRuntime.getDidMethodPrefix(normalizedDid);
    const resolverDefinition = didResolverRuntime.getDidResolverDefinition(normalizedDid);

    if (!methodPrefix || !resolverDefinition || typeof resolverDefinition.resolve !== 'function') {
      this.status = 'unsupported';
      this.unsupportedMethod = methodPrefix ?? methodPrefixForUnsupportedDid(normalizedDid);
      return;
    }

    const resolutionId = this._activeResolutionId + 1;
    this._activeResolutionId = resolutionId;

    this.status = 'resolving';
    this.errorMessage = '';
    this.unsupportedMethod = '';
    this.resolutionResult = null;

    let resolutionResult;
    try {
      resolutionResult = await resolverDefinition.resolve(normalizedDid);
    } catch (error) {
      if (resolutionId !== this._activeResolutionId) {
        return;
      }

      this.status = 'error';
      this.errorMessage = `Resolution failed: ${error instanceof Error ? error.message : 'Unknown resolver failure'}`;
      return;
    }

    if (resolutionId !== this._activeResolutionId) {
      return;
    }

    this.status = 'resolved';
    this.resolutionResult = {
      didResolutionMetadata : resolutionResult.didResolutionMetadata ?? {},
      didDocumentMetadata   : resolutionResult.didDocumentMetadata ?? {},
      didDocument           : resolutionResult.didDocument,
    };
  }
}

if (!customElements.get('resolver-page')) {
  customElements.define('resolver-page', ResolverPage);
}

function getDidResolverRuntime() {
  const runtime = window[resolverRuntimeWindowKey];
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }

  if (typeof runtime.getDidMethodPrefix !== 'function') {
    return null;
  }

  if (typeof runtime.getDidResolverDefinition !== 'function') {
    return null;
  }

  return runtime;
}

/**
 * @param {string} did
 */
function methodPrefixForUnsupportedDid(did) {
  const segments = did.trim().split(':');
  if (segments.length > 1 && segments[1].length > 0) {
    return `did:${segments[1].toLowerCase()}`;
  }

  return 'did:unknown';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}
