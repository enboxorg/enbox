import { requestWebAwesomeDiscovery } from '../../utils/webawesome-loader.js';

class XMenubar extends HTMLElement {
  static get observedAttributes() {
    return ['size'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          inline-size: 100%;
          min-inline-size: 0;
          box-sizing: border-box;
          --x-menubar-gap: var(--wa-space-2xs, 0.25rem);
        }

        #items {
          display: flex;
          flex: 1 1 auto;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: nowrap;
          min-inline-size: 0;
          gap: 0;
        }

        #items-slot {
          display: contents;
        }

        ::slotted(*) {
          flex: 0 0 auto;
          white-space: nowrap;
          box-sizing: border-box !important;
          margin-inline-start: var(--x-menubar-gap);
        }

        ::slotted([data-overflowing="true"]) {
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
        }

        #more {
          display: flex;
          margin-inline-start: var(--x-menubar-gap);
          flex: 0 0 auto;
        }

        #more[hidden] {
          display: none !important;
        }
      </style>

      <div id="items">
        <slot id="items-slot"></slot>
      </div>

      <wa-dropdown id="more" placement="bottom-end" hidden>
        <wa-button id="more-btn" slot="trigger" appearance="filled-outlined" with-caret>More</wa-button>
      </wa-dropdown>
    `;

    this.itemsContainer = this.shadowRoot.getElementById('items');
    this.slotElement = this.shadowRoot.getElementById('items-slot');
    this.moreDropdown = this.shadowRoot.getElementById('more');
    this.moreButton = this.shadowRoot.getElementById('more-btn');

    this.observer = null;
    this.menuItems = [];
    this.cleanupHandlers = [];

    this.onSlotChange = this.onSlotChange.bind(this);
    this.onDropdownShow = this.onDropdownShow.bind(this);
  }

  connectedCallback() {
    requestWebAwesomeDiscovery(this.shadowRoot);
    this.slotElement?.addEventListener('slotchange', this.onSlotChange);
    this.moreDropdown?.addEventListener('wa-show', this.onDropdownShow);
    this.setupObserver();
    this.observeItems();
    this.syncSize();
    queueMicrotask(() => this.updateOverflowMenu());
  }

  disconnectedCallback() {
    this.slotElement?.removeEventListener('slotchange', this.onSlotChange);
    this.moreDropdown?.removeEventListener('wa-show', this.onDropdownShow);
    this.observer?.disconnect();
    this.clearMenu();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'size' && oldValue !== newValue) {
      this.syncSize();
    }
  }

  getAssignedItems() {
    if (!this.slotElement) {
      return [];
    }

    return this.slotElement
      .assignedElements({ flatten: true })
      .filter((element) => element instanceof HTMLElement);
  }

  syncSize() {
    if (!this.moreDropdown || !this.moreButton) {
      return;
    }

    const size = this.getAttribute('size');
    if (size) {
      this.moreDropdown.setAttribute('size', size);
      this.moreButton.setAttribute('size', size);
    } else {
      this.moreDropdown.removeAttribute('size');
      this.moreButton.removeAttribute('size');
    }
  }

  setupObserver() {
    if (!this.itemsContainer) {
      return;
    }

    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      let changed = false;

      for (const entry of entries) {
        const overflowing = !entry.isIntersecting || entry.intersectionRatio < 0.99;
        const next = overflowing ? 'true' : 'false';
        if (entry.target.getAttribute('data-overflowing') !== next) {
          entry.target.setAttribute('data-overflowing', next);
          changed = true;
        }
      }

      if (changed) {
        this.updateOverflowMenu();
      }
    }, {
      root: this.itemsContainer,
      threshold: 0.99,
    });
  }

  observeItems() {
    if (!this.observer) {
      return;
    }

    this.observer.disconnect();
    for (const element of this.getAssignedItems()) {
      element.setAttribute('data-overflowing', 'false');
      this.observer.observe(element);
    }
  }

  onSlotChange() {
    this.observeItems();
    this.updateOverflowMenu();
  }

  onDropdownShow() {
    this.updateOverflowMenu();
  }

  clearMenu() {
    for (const cleanup of this.cleanupHandlers) {
      cleanup();
    }
    this.cleanupHandlers = [];

    for (const item of this.menuItems) {
      item.remove();
    }
    this.menuItems = [];
  }

  createMenuItem(sourceElement) {
    const item = document.createElement('wa-dropdown-item');

    const label = sourceElement.getAttribute('label')
      || sourceElement.getAttribute('aria-label')
      || (sourceElement.textContent ? sourceElement.textContent.trim() : '');
    item.textContent = label || 'Action';

    const icon = sourceElement.querySelector('wa-icon[slot="start"], wa-icon');
    if (icon instanceof HTMLElement) {
      const iconClone = icon.cloneNode(true);
      if (iconClone instanceof HTMLElement) {
        iconClone.setAttribute('slot', 'icon');
        item.prepend(iconClone);
      }
    }

    if (sourceElement.hasAttribute('disabled')) {
      item.setAttribute('disabled', '');
    }

    if (sourceElement.getAttribute('variant') === 'danger') {
      item.setAttribute('variant', 'danger');
    }

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (typeof this.moreDropdown?.hide === 'function') {
        this.moreDropdown.hide();
      } else if (this.moreDropdown) {
        this.moreDropdown.open = false;
      }

      if (typeof sourceElement.click === 'function') {
        sourceElement.click();
      }
    };

    item.addEventListener('click', onClick);
    this.cleanupHandlers.push(() => item.removeEventListener('click', onClick));

    return item;
  }

  updateOverflowMenu() {
    if (!this.moreDropdown || !this.moreButton) {
      return;
    }

    const assignedItems = this.getAssignedItems();
    const overflowingItems = assignedItems.filter((element) => element.getAttribute('data-overflowing') === 'true');

    if (overflowingItems.length === 0) {
      this.clearMenu();
      if (typeof this.moreDropdown.hide === 'function') {
        this.moreDropdown.hide();
      } else {
        this.moreDropdown.open = false;
      }
      this.moreDropdown.hidden = true;
      return;
    }

    const wasHidden = this.moreDropdown.hidden;
    this.moreDropdown.hidden = false;

    this.clearMenu();
    for (const sourceElement of overflowingItems) {
      const item = this.createMenuItem(sourceElement);
      this.moreDropdown.append(item);
      this.menuItems.push(item);
    }

    requestWebAwesomeDiscovery(this.shadowRoot);

    if (wasHidden) {
      requestAnimationFrame(() => {
        this.observeItems();
      });
    }
  }
}

if (!customElements.get('x-menubar')) {
  customElements.define('x-menubar', XMenubar);
}
