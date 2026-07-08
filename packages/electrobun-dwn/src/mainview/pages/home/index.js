import { LitElement, html } from 'lit';
import { ContextConsumer } from '@lit/context';
import { SignalWatcher } from '@lit-labs/signals';
import { appContext } from '../../state/app-context.js';
import './index.css';

class HomePage extends SignalWatcher(LitElement) {
  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.appStore = null;
    this.appStoreConsumer = new ContextConsumer(this, {
      context   : appContext,
      subscribe : true,
      callback  : (value) => {
        this.appStore = value;
      },
    });
  }

  get connectionSnapshot() {
    return this.appStore?.connection.snapshot.get() ?? {
      state         : 'connecting',
      endpoint      : '--',
      serverName    : '--',
      serverVersion : '--',
      wsSupport     : '--',
      updatedAt     : '--',
      serverUrl     : '',
    };
  }

  get connectionStateLabel() {
    if (this.connectionSnapshot.state === 'online') {
      return 'Online';
    }

    if (this.connectionSnapshot.state === 'offline') {
      return 'Offline';
    }

    return 'Connecting...';
  }

  render() {
    const connectionSnapshot = this.connectionSnapshot;

    return html`
      <div class="wa-stack wa-gap-2xl dashboard">
        <section class="wa-stack">
          <div class="wa-flank:end">
            <h1>Home</h1>

            <wa-button appearance="outlined" variant="success">
              <wa-icon slot="start" name="piggy-bank" variant="solid"></wa-icon>
              Pay Out
            </wa-button>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

          <div class="wa-split wa-gap-xl wa-align-items-start">
            <div class="wa-cluster wa-align-items-start wa-gap-xl" style="flex: auto">
              <wa-card class="metric-card" appearance="filled" style="flex: auto">
                <div class="wa-caption-s">Requests Processed</div>
                <div class="metric-value">9,842</div>
                <div class="metric-note">+14% from yesterday</div>
              </wa-card>

              <wa-card class="metric-card" appearance="filled" style="flex: auto">
                <div class="wa-caption-s">Data Throughput</div>
                <div class="metric-value">241 MB</div>
                <div class="metric-note">Peak at 11:40 AM</div>
              </wa-card>
            </div>

            <div class="wa-cluster wa-align-items-start wa-gap-xl" style="flex: auto">
              <wa-card class="metric-card" appearance="filled" style="flex: auto">
                <div class="wa-caption-s">Queue Depth</div>
                <div class="metric-value">17</div>
                <div class="metric-note">Healthy, under threshold</div>
              </wa-card>

              <wa-card class="metric-card" appearance="filled" style="flex: auto">
                <div class="wa-caption-s">Node Status</div>
                <div class="metric-value">${this.connectionStateLabel}</div>
                <div class="status-grid">
                  <div class="status-row">
                    <span>Endpoint</span>
                    <strong>${connectionSnapshot.endpoint}</strong>
                  </div>
                  <div class="status-row">
                    <span>Server</span>
                    <strong>${connectionSnapshot.serverName}</strong>
                  </div>
                  <div class="status-row">
                    <span>Version</span>
                    <strong>${connectionSnapshot.serverVersion}</strong>
                  </div>
                  <div class="status-row">
                    <span>WebSocket</span>
                    <strong>${connectionSnapshot.wsSupport}</strong>
                  </div>
                  <div class="status-row">
                    <span>Updated</span>
                    <strong>${connectionSnapshot.updatedAt}</strong>
                  </div>
                </div>
                <div class="metric-note">
                  ${connectionSnapshot.serverUrl
                    ? html`
                        <a
                          class="server-url"
                          href=${connectionSnapshot.serverUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          ${connectionSnapshot.serverUrl}
                        </a>
                      `
                    : html`<span class="server-url">--</span>`}
                </div>
                <div class="metric-note">
                  Close this window to stop the server. The DWN uses ports 55500-55509, then 3000.
                </div>
              </wa-card>
            </div>
          </div>
        </section>

        <section class="wa-stack">
          <div class="wa-flank:end">
            <h1>Recent Activity</h1>

            <div class="wa-cluster wa-gap-s">
              <wa-button appearance="outlined" style="flex: auto">
                <wa-icon slot="start" name="plus" variant="solid"></wa-icon>
                Add
              </wa-button>
              <wa-button appearance="outlined" style="flex: auto">
                <wa-icon slot="start" name="gear" variant="solid"></wa-icon>
                Edit
              </wa-button>
            </div>
          </div>

          <wa-divider style="padding-bottom: var(--spacing)"></wa-divider>

          <wa-card appearance="filled" style="--spacing: var(--wa-space-xs); background-color: var(--wa-color-surface-lowered); border: var(--panel-border)">
            <div class="wa-grid wa-gap-xs" style="--min-column-size: 32ch">
              <wa-card class="grid-card" appearance="outlined">
                <div class="wa-caption-s">Payments</div>
                <div class="metric-value">1,238</div>
                <div class="metric-note">97.2% succeeded</div>
              </wa-card>
              <wa-card class="grid-card" appearance="outlined">
                <div class="wa-caption-s">Gross Volume</div>
                <div class="metric-value">$428,300</div>
                <div class="metric-note">+9.1% from baseline</div>
              </wa-card>
              <wa-card class="grid-card" appearance="outlined">
                <div class="wa-caption-s">Net Volume</div>
                <div class="metric-value">$404,112</div>
                <div class="metric-note">Fees included</div>
              </wa-card>
              <wa-card class="grid-card" appearance="outlined">
                <div class="wa-caption-s">Top Clients</div>
                <div class="metric-value">17</div>
                <div class="metric-note">Cover 62% of traffic</div>
              </wa-card>
            </div>
          </wa-card>
        </section>
      </div>
    `;
  }
}

if (!customElements.get('home-page')) {
  customElements.define('home-page', HomePage);
}
