import { LitElement, html, css } from "lit";
import { msg, localized, str } from "@lit/localize";
import { property, state } from "lit/decorators.js";

type Message = {
  id: string; // page ID
};

type InitMessage = Message & {
  msg: "init";
  browsers: number;
  width: number;
  height: number;
};

type ScreencastMessage = Message & {
  msg: "screencast";
  url: string; // page URL
  data: string; // base64 PNG data
};

type CloseMessage = Message & {
  msg: "close";
};

/**
 * Watch page crawl
 *
 * Usage example:
 * ```ts
 * <btrix-screencast
 *   orgId=${orgId}
 *   crawlId=${crawlId}
 * ></btrix-screencast>
 * ```
 */
@localized()
export class Screencast extends LitElement {
  static baseURL = `${window.location.protocol === "https:" ? "wss" : "ws"}:${
    process.env.WEBSOCKET_HOST || window.location.host
  }/watch`;
  static maxRetries = 10;

  static styles = css`
    .wrapper {
      position: relative;
    }

    .spinner {
      text-align: center;
      font-size: 2rem;
    }

    .container {
      display: grid;
      gap: 1rem;
    }

    .screen {
      border: 1px solid var(--sl-color-neutral-300);
      border-radius: var(--sl-border-radius-large);
      overflow: hidden;
    }

    .screen[role="button"] {
      cursor: pointer;
      transition: var(--sl-transition-fast) box-shadow;
    }

    .screen[role="button"]:hover {
      box-shadow: var(--sl-shadow-medium);
    }

    figure {
      margin: 0;
    }

    .caption {
      padding: var(--sl-spacing-x-small);
      flex: 1;
      border-bottom: 1px solid var(--sl-panel-border-color);
      color: var(--sl-color-neutral-600);
    }

    .caption,
    .dialog-label {
      display: block;
      font-size: var(--sl-font-size-x-small);
      line-height: 1;
      /* Truncate: */
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .dialog-label {
      max-width: 40em;
    }

    .frame {
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: var(--sl-color-sky-50);
      overflow: hidden;
    }

    .frame > img {
      display: block;
      width: 100%;
      height: auto;
      box-shadow: 0;
      outline: 0;
      border: 0;
    }

    sl-spinner {
      font-size: 1.75rem;
    }
  `;

  @property({ type: String })
  authToken?: string;

  @property({ type: String })
  orgId?: string;

  @property({ type: String })
  crawlId?: string;

  @property({ type: Number })
  scale: number = 1;

  // List of browser screens
  @state()
  private dataList: Array<ScreencastMessage | null> = [];

  @state()
  private focusedScreenData?: ScreencastMessage;

  // Websocket connections
  private wsMap: Map<number, WebSocket> = new Map();
  // Map data order to screen data
  private dataMap: { [index: number]: ScreencastMessage | null } = {};
  // Map page ID to data order
  private pageOrderMap: Map<string, number> = new Map();
  // Number of available browsers.
  // Multiply by scale to get available browser window count
  private browsersCount = 1;
  private screenWidth = 640;
  private screenHeight = 480;
  private timerIds: number[] = [];

  protected firstUpdated() {
    // Connect to websocket server
    this.connectAll();
  }

  async updated(changedProperties: Map<string, any>) {
    if (
      changedProperties.get("orgId") ||
      changedProperties.get("crawlId") ||
      changedProperties.get("authToken")
    ) {
      // Reconnect
      this.disconnectAll();
      this.connectAll();
    } else {
      const prevScale = changedProperties.get("scale");
      if (prevScale) {
        if (this.scale > prevScale) {
          this.scaleUp();
        } else {
          this.scaleDown();
        }
      }
    }
  }

  disconnectedCallback() {
    this.disconnectAll();
    this.timerIds.forEach(window.clearTimeout);
    super.disconnectedCallback();
  }

  render() {
    return html`
      <div class="wrapper">
        <div
          class="container"
          style="grid-template-columns: repeat(${this
            .browsersCount}, minmax(0, 1fr)); grid-template-rows: repeat(${this
            .scale}, minmax(2rem, auto))"
        >
          ${this.dataList.map(
            (pageData) =>
              html` <figure
                class="screen"
                title=${pageData?.url || ""}
                role=${pageData ? "button" : "presentation"}
                @click=${pageData
                  ? () => (this.focusedScreenData = pageData)
                  : () => {}}
              >
                <figcaption class="caption">
                  ${pageData?.url || html`&nbsp;`}
                </figcaption>
                <div
                  class="frame"
                  style="aspect-ratio: ${this.screenWidth / this.screenHeight}"
                >
                  ${pageData
                    ? html`<img src="data:image/png;base64,${pageData.data}" />`
                    : html`<sl-spinner></sl-spinner>`}
                </div>
              </figure>`
          )}
        </div>
      </div>

      <sl-dialog
        ?open=${Boolean(this.focusedScreenData)}
        style="--width: ${this.screenWidth}px;
          --header-spacing: var(--sl-spacing-small);
          --body-spacing: 0;
          "
        @sl-after-hide=${this.unfocusScreen}
      >
        <span
          class="dialog-label"
          slot="label"
          title=${this.focusedScreenData?.url || ""}
        >
          ${this.focusedScreenData?.url}
        </span>

        ${this.focusedScreenData
          ? html`
              <img
                src="data:image/png;base64,${this.focusedScreenData.data}"
                title="${this.focusedScreenData.url}"
              />
            `
          : ""}
      </sl-dialog>
    `;
  }

  private scaleUp() {
    // Reconnect after 20 second delay
    this.timerIds.push(
      window.setTimeout(() => {
        this.connectAll();
      }, 20 * 1000)
    );
  }

  private scaleDown() {
    for (let idx = this.wsMap.size - 1; idx > this.scale - 1; idx--) {
      const ws = this.wsMap.get(idx);

      if (ws) {
        ws.close(1000);
        this.wsMap.delete(idx);
      }
    }
  }

  /**
   * Connect to all crawler instances
   */
  private connectAll() {
    if (!this.orgId || !this.crawlId) {
      return;
    }

    for (let idx = 0; idx < this.scale; idx++) {
      if (!this.wsMap.get(idx)) {
        const ws = this.connectWs(idx);

        ws.addEventListener("close", (e) => {
          if (e.code !== 1000) {
            // Not normal closure, try connecting again after 10 sec
            this.timerIds.push(
              window.setTimeout(() => {
                this.retryConnectWs({ index: idx });
              }, 10 * 1000)
            );
          }
        });

        this.wsMap.set(idx, ws);
      }
    }
  }

  private disconnectAll() {
    this.wsMap.forEach((ws, i) => {
      ws.close(1000);
      this.wsMap.delete(i);
    });
  }

  private handleMessage(
    message: InitMessage | ScreencastMessage | CloseMessage
  ) {
    if (message.msg === "init") {
      this.dataList = Array.from(
        { length: message.browsers * this.scale },
        () => null
      );
      this.dataMap = this.dataList.reduce(
        (acc, val, i) => ({
          ...acc,
          [i]: val,
        }),
        {}
      );
      this.browsersCount = message.browsers;
      this.screenWidth = message.width;
      this.screenHeight = message.height;
    } else {
      const { id } = message;

      if (message.msg === "screencast") {
        if (message.url === "about:blank") {
          // Skip blank pages
          return;
        }

        let idx = this.pageOrderMap.get(id);

        if (idx === undefined) {
          // Find and fill first empty slot
          idx = this.dataList.indexOf(null);

          if (idx === -1) {
            console.debug("no empty slots");
          }

          this.pageOrderMap.set(id, idx);
        }

        if (this.focusedScreenData?.id === id) {
          this.focusedScreenData = message;
        }

        this.dataMap[idx] = message;
        this.updateDataList();
      } else if (message.msg === "close") {
        const idx = this.pageOrderMap.get(id);

        if (idx !== undefined && idx !== null) {
          this.dataMap[idx] = null;
          this.updateDataList();
          this.pageOrderMap.set(id, -1);
        }
      }
    }
  }

  /**
   * Connect & receive messages from crawler websocket instance
   */
  private connectWs(index: number): WebSocket {
    const ws = new WebSocket(
      `${Screencast.baseURL}/${this.orgId}/${
        this.crawlId
      }/${index}/ws?auth_bearer=${this.authToken || ""}`
    );

    ws.addEventListener("message", ({ data }) => {
      this.handleMessage(JSON.parse(data));
    });

    return ws;
  }

  /**
   * Retry connecting to websocket with exponential backoff
   */
  private retryConnectWs(opts: {
    index: number;
    retries?: number;
    delaySec?: number;
  }): void {
    const { index, retries = 0, delaySec = 10 } = opts;

    if (index >= this.scale) {
      return;
    }

    const ws = this.connectWs(index);

    ws.addEventListener("close", (e) => {
      if (e.code !== 1000) {
        // Not normal closure, try connecting again
        if (retries < Screencast.maxRetries) {
          this.timerIds.push(
            window.setTimeout(() => {
              this.retryConnectWs({
                index,
                retries: retries + 1,
                delaySec: delaySec * 2,
              });
            }, delaySec * 1000)
          );
        } else {
          console.error(
            `stopping websocket retries, tried ${Screencast.maxRetries} times with ${delaySec} second delay`
          );
        }
      }
    });
  }

  updateDataList() {
    this.dataList = Object.values(this.dataMap);
  }

  unfocusScreen() {
    this.updateDataList();
    this.focusedScreenData = undefined;
  }
}
