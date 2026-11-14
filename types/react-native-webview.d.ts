/**
 * Local typings for react-native-webview@14.0.1.
 *
 * The package ships a stale `index.d.ts` at its root that declares a generic
 * `class WebView<P = undefined> extends Component<WebViewProps & P>` — the
 * `& P` with the default `undefined` collapses every prop down to `never`, so
 * every <WebView> JSX element fails to typecheck. The real runtime API (the
 * imperative-handle methods: goBack, goForward, reload, stopLoading,
 * injectJavaScript, requestFocus, postMessage) matches the class shape
 * declared below. This file is wired in via `paths` in tsconfig.json;
 * remove it when the package ships usable top-level types again.
 */
import type { Component } from 'react';
import type {
  WebViewProps,
  WebViewNavigation,
  WebViewMessageEvent,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  ShouldStartLoadRequestEvent,
  FileDownload,
} from 'react-native-webview/lib/WebViewTypes';

export type {
  WebViewProps,
  WebViewNavigation,
  WebViewMessageEvent,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  ShouldStartLoadRequestEvent,
  FileDownload,
};

export type WebViewRef = Component<WebViewProps> & {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stopLoading(): void;
  injectJavaScript(script: string): void;
  requestFocus(): void;
  postMessage(data: string): void;
};

declare const WebView: {
  new (props: WebViewProps): WebViewRef;
  displayName: string;
};

export { WebView };
export default WebView;
