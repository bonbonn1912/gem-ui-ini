import { createEffect, onCleanup } from "solid-js";

/**
 * Schließt ein Popover-Menü, sobald daneben geklickt oder Escape gedrückt wird.
 *
 * Gedacht für `<details>`-Menüs, die als Dropdown auftreten (Ordnerliste,
 * Session-Menü, Anhang-Menü). Ein `<details>` bleibt von sich aus offen, bis
 * man erneut auf die Zusammenfassung klickt — das fühlt sich neben Modalen,
 * die per Klick daneben zugehen, inkonsistent an.
 *
 * Der Rückgabewert wird an das `<details>`-Element gehängt:
 *
 *   const menuRef = useDismissOnOutsideClick<HTMLDetailsElement>();
 *   <details ref={menuRef} class="roots-menu"> … </details>
 *
 * Es wird bewusst kein zusätzlicher Komponenten-State benutzt: `<details>` verwaltet seinen
 * Offen-Zustand selbst, und ein zusätzlicher State würde nur auseinanderlaufen.
 */
export function useDismissOnOutsideClick<T extends HTMLElement = HTMLDetailsElement>(): (element: T) => void {
  let ref!: T;

  createEffect(() => {
    const isOpen = () => {
      const element = ref;
      if (!element) return false;
      return element instanceof HTMLDetailsElement
        ? element.open
        : element.dataset.open === "true";
    };

    const close = () => {
      const element = ref;
      if (element instanceof HTMLDetailsElement) element.open = false;
    };

    const onPointerDown = (event: MouseEvent) => {
      const element = ref;
      if (!element || !isOpen()) return;
      const target = event.target as Node | null;
      if (target && element.contains(target)) return;
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isOpen()) return;
      close();
      // Der Fokus soll auf dem Auslöser landen, nicht ins Leere fallen.
      ref?.querySelector("summary")?.focus();
    };

    // `mousedown` statt `click`: so schließt das Menü auch dann, wenn der Klick
    // daneben auf einem Element landet, das den Klick selbst abfängt.
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  return (element: T) => { ref = element; };
}
