import { LitElement, html } from 'lit';
import './index.css';

class PermissionsPage extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div class="wa-stack wa-gap-xl dashboard page-block">
        <section class="wa-stack">
          <div class="wa-flank:end">
            <h1>Permissions</h1>
            <wa-button appearance="outlined" variant="danger">
              <wa-icon slot="start" name="shield" variant="solid"></wa-icon>
              Review Critical
            </wa-button>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

          <div class="wa-grid wa-gap-s" style="--min-column-size: 28ch">
            <wa-card class="grid-card" appearance="outlined">
              <div class="wa-caption-s">Active Grants</div>
              <div class="metric-value">94</div>
              <div class="metric-note">Scoped by protocol and method</div>
            </wa-card>

            <wa-card class="grid-card" appearance="outlined">
              <div class="wa-caption-s">Expiring Soon</div>
              <div class="metric-value">7</div>
              <div class="metric-note">Within the next 72 hours</div>
            </wa-card>

            <wa-card class="grid-card" appearance="outlined">
              <div class="wa-caption-s">Denied Requests</div>
              <div class="metric-value">12</div>
              <div class="metric-note">Last 24 hours</div>
            </wa-card>
          </div>
        </section>

        <wa-callout variant="warning">
          Rotate app tokens after permission changes to ensure stale sessions are rejected.
        </wa-callout>
      </div>
    `;
  }
}

if (!customElements.get('permissions-page')) {
  customElements.define('permissions-page', PermissionsPage);
}
