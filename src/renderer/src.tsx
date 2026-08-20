import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { Icon } from "./components/Icon";
import "./styles/app.css";

class RendererErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Renderer error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-screen">
        <Icon name="warning" size={28} />
        <h1>Die Oberfläche ist abgestürzt</h1>
        <p>{this.state.error.message}</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>
          Oberfläche neu laden
        </button>
      </main>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element not found");

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);

