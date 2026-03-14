import { LitElement, css, html } from 'lit';

class XOverflowToolbar extends LitElement {
  static properties = {
    hasOverflow: { type: Boolean, attribute: 'has-overflow', reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      justify-content: var(--x-overflow-toolbar-justify, flex-end);
      gap: var(--x-overflow-toolbar-gap, var(--wa-space-2xs));
      flex: 1 1 auto;
      min-inline-size: 0;
      overflow: hidden;
    }

    .track {
      display: inline-flex;
      flex-wrap: nowrap;
      align-items: center;
      justify-content: flex-end;
      flex: 0 0 auto;
      inline-size: max-content;
      min-inline-size: max-content;
      gap: var(--x-overflow-toolbar-gap, var(--wa-space-2xs));
    }

    .track > slot {
      display: contents;
    }

    .track > slot::slotted(wa-button) {
      flex: 0 0 auto;
      display: inline-flex;
      inline-size: auto;
      min-inline-size: max-content;
      margin: 0;
    }

    .overflow-dropdown[hidden] {
      display: none;
    }

    #overflow-trigger::part(base) {
      min-inline-size: 2.4rem;
      justify-content: center;
    }
  `;

  constructor() {
    super();
    this.hasOverflow = false;
    this._resizeObserver = new ResizeObserver(() => {
      this.logTrackBoundaryState();
    });
  }

  firstUpdated() {
    const track = this.renderRoot.querySelector('.track');
    if (!(track instanceof HTMLElement)) {
      return;
    }

    this._resizeObserver.observe(this);
    this._resizeObserver.observe(track);
    this.logTrackBoundaryState();
  }

  onTrackSlotChange = () => {
    this.logTrackBoundaryState();
  };

  logTrackBoundaryState() {
    const track = this.renderRoot.querySelector('.track');
    if (!(track instanceof HTMLElement)) {
      return;
    }

    const hostRect = this.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const epsilon = 0.5;
    const overflowsLeft = trackRect.left < (hostRect.left - epsilon);
    const overflowsRight = trackRect.right > (hostRect.right + epsilon);

    console.log({
      overflowsLeft,
      overflowsRight,
      overflowsHorizontally: overflowsLeft || overflowsRight,
      hostLeft: hostRect.left,
      hostRight: hostRect.right,
      trackLeft: trackRect.left,
      trackRight: trackRect.right,
    });
  }

  disconnectedCallback() {
    this._resizeObserver.disconnect();
    super.disconnectedCallback();
  }

  render() {
    return html`
      <div class="track">
        <slot @slotchange=${this.onTrackSlotChange}></slot>
      </div>

      <wa-dropdown class="overflow-dropdown" placement="bottom-end" ?hidden=${!this.hasOverflow}>
        <wa-button
          id="overflow-trigger"
          slot="trigger"
          appearance="outlined"
          size="small"
          aria-label="More actions"
        >
          ...
        </wa-button>

        <slot name="overflow"></slot>
      </wa-dropdown>
    `;
  }
}

if (!customElements.get('x-overflow-toolbar')) {
  customElements.define('x-overflow-toolbar', XOverflowToolbar);
}
