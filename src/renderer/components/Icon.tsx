import type { SVGProps } from "react";

export type IconName =
  | "archive"
  | "arrow-left"
  | "arrow-up"
  | "branch"
  | "brain"
  | "check"
  | "chevron-down"
  | "chat"
  | "changes"
  | "clock"
  | "copy"
  | "folder"
  | "folder-plus"
  | "external"
  | "file-text"
  | "globe"
  | "image"
  | "link"
  | "menu"
  | "more"
  | "paperclip"
  | "pin"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "shield"
  | "sparkle"
  | "stop"
  | "tool"
  | "trash"
  | "warning"
  | "x";

export interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };

  switch (name) {
    case "archive":
      return (
        <svg {...common}>
          <path d="M4 8v11h16V8" />
          <path d="M3 4h18v4H3zM9 12h6" />
        </svg>
      );
    case "arrow-left":
      return (
        <svg {...common}>
          <path d="M19 12H5m6-6-6 6 6 6" />
        </svg>
      );
    case "arrow-up":
      return (
        <svg {...common}>
          <path d="m12 19 0-14M6.5 10.5 12 5l5.5 5.5" />
        </svg>
      );
    case "brain":
      return (
        <svg {...common}>
          <path d="M9.5 4.4A3 3 0 0 0 4.7 7a3.1 3.1 0 0 0 .1 5.4A3.4 3.4 0 0 0 8 17a3 3 0 0 0 4 2.8V6.2a2.8 2.8 0 0 0-2.5-1.8Z" />
          <path d="M14.5 4.4A3 3 0 0 1 19.3 7a3.1 3.1 0 0 1-.1 5.4A3.4 3.4 0 0 1 16 17a3 3 0 0 1-4 2.8M8 8.5a4 4 0 0 0 4 3.8m4-3.8a4 4 0 0 1-4 3.8" />
        </svg>
      );
    case "branch":
      return (
        <svg {...common}>
          <circle cx="6" cy="5" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="6" cy="19" r="2" />
          <path d="M6 7v10M8 9h4a6 6 0 0 0 6-6v2" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m5 12.5 4.3 4.3L19 7" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <path d="m7 9.5 5 5 5-5" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2.2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3Z" />
        </svg>
      );
    case "changes":
      return (
        <svg {...common}>
          <path d="M7 4v10m0 0-3-3m3 3 3-3M17 20V10m0 0-3 3m3-3 3 3" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
        </svg>
      );
    case "folder-plus":
      return (
        <svg {...common}>
          <path d="M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
          <path d="M12 10v6m-3-3h6" />
        </svg>
      );
    case "external":
      return (
        <svg {...common}>
          <path d="M14 4h6v6M20 4l-9 9" />
          <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
        </svg>
      );
    case "file-text":
      return (
        <svg {...common}>
          <path d="M6 3.5h8l4 4V20H6Z" />
          <path d="M14 3.5V8h4M9 12h6m-6 3h6" />
        </svg>
      );
    case "globe":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.8 12h16.4M12 3.5c2.3 2.3 3.3 5.1 3.3 8.5S14.3 18.2 12 20.5C9.7 18.2 8.7 15.4 8.7 12S9.7 5.8 12 3.5Z" />
        </svg>
      );
    case "image":
      return (
        <svg {...common}>
          <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
          <circle cx="9" cy="9.5" r="1.5" />
          <path d="m5.5 18 4.7-4.7 2.7 2.7 2-2 3.6 4" />
        </svg>
      );
    case "link":
      return (
        <svg {...common}>
          <path d="m10 13.8 4-4" />
          <path d="M7.8 16H6.5a4 4 0 0 1 0-8H10m6.2 0h1.3a4 4 0 0 1 0 8H14" />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "paperclip":
      return (
        <svg {...common}>
          <path d="m9.5 12.5 5.7-5.7a3 3 0 0 1 4.2 4.2l-7.8 7.8a5 5 0 0 1-7.1-7.1l7.3-7.3" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="m14 4 6 6-3 1-3.5 3.5.5 3-1 1-7.5-7.5 1-1 3 .5L13 7Z" />
          <path d="m9 15-5 5" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M19 8a8 8 0 1 0 1 7M19 4v4h-4" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 4 4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 4.4 2.8 7.7 7 10 4.2-2.3 7-5.6 7-10V6Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 2.8c.5 4.7 2.5 6.7 7.2 7.2-4.7.5-6.7 2.5-7.2 7.2-.5-4.7-2.5-6.7-7.2-7.2 4.7-.5 6.7-2.5 7.2-7.2Z" />
          <path d="M19 16.2c.2 1.8 1 2.6 2.8 2.8-1.8.2-2.6 1-2.8 2.8-.2-1.8-1-2.6-2.8-2.8 1.8-.2 2.6-1 2.8-2.8Z" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "tool":
      return (
        <svg {...common}>
          <path d="M14.8 6.2a4 4 0 0 0-5 5L4 17v3h3l5.8-5.8a4 4 0 0 0 5-5l-2.4 2.4-3-3Z" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4.5 7h15M9 7V4.5h6V7m3 0-1 13h-10L6 7m4 4v5m4-5v5" />
        </svg>
      );
    case "warning":
      return (
        <svg {...common}>
          <path d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4m0 3.5v.1" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      );
  }
}
