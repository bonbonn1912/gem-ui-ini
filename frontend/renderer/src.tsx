import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./app/App";
import { Icon } from "./components/Icon";
import { installTauriBridge } from "./tauri-bridge";
import "./styles/app.css";

// Tauri has no preload phase. Install its typed renderer adapter before any
// component can read window.gemUi.
installTauriBridge();

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element not found");

render(
  () => (
    <ErrorBoundary
      fallback={(error, reset) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Renderer error", error);
        return (
          <main class="fatal-screen">
            <Icon name="warning" size={28} />
            <h1>Die Oberfläche ist abgestürzt</h1>
            <p>{message}</p>
            <button class="primary-button" type="button" onClick={() => { reset(); window.location.reload(); }}>
              Oberfläche neu laden
            </button>
          </main>
        );
      }}
    >
      <App />
    </ErrorBoundary>
  ),
  root,
);
