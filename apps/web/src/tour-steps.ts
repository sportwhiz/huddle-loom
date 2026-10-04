export type Journey = "home" | "board" | "admin" | "account" | "connections";
export type TourStep = {
  title: string;
  text: string;
  hint: string;
  target: string;
  heading?: string;
  child?: string;
  reveal?: "studio-navigation";
  icon?: "lock" | "apps" | "help";
};
export const tourBits: Record<Journey, number> = {
  home: 1,
  board: 2,
  admin: 4,
  account: 8,
  connections: 16,
};
const step = (
  title: string,
  text: string,
  hint: string,
  target: string,
  extra: Partial<TourStep> = {},
): TourStep => ({ title, text, hint, target, ...extra });
const nav = '.identity-nav a[aria-current="page"], .identity-mobile-nav';
export function tourSteps(
  journey: Journey,
  role: string,
  reader: boolean,
  path: string,
  platform = "cloudflare",
): TourStep[] {
  if (journey === "home")
    return [
      role === "guest"
        ? step(
            "Your shared ideas live here",
            "Open a board someone has shared with you. Your Studio only shows work you have permission to see.",
            "An invitation gives you access to its board, not the whole Studio.",
            ".workspace-heading h1",
          )
        : step(
            "Make space for your next idea",
            "New board opens a private whiteboard. Choose its workbook, give it a name, and start with a note.",
            "You decide when your board is ready to share.",
            '[data-onboarding="new-board"], .heading-create-button',
          ),
      step(
        "Keep a thread within reach",
        "All boards, Favorites, and Shared with me are different views of your work. A star keeps a useful board close at hand.",
        "Search finds notes as well as board names.",
        ".sidebar-nav",
        { reveal: "studio-navigation" },
      ),
      step(
        "Give related ideas a home",
        "Workbooks collect related boards. Folders organize your workbooks. Open a workbook to see its boards and sharing options.",
        "Sharing a workbook gives access to the boards inside it.",
        ".sidebar-section h2",
        { reveal: "studio-navigation" },
      ),
      step(
        "Find the thought you remember",
        "Search across your boards and their notes. Clear the search to return to the view you were using.",
        "Try a phrase from a note, even if you forgot the board name.",
        '[data-onboarding="search"]',
      ),
      step(
        "Weave in your assistant",
        "Connected apps walks you through connecting ChatGPT, Claude, or another MCP client. Ask it to turn your workflow into editable notes and arrows.",
        "You choose which boards it can read or change.",
        '[data-onboarding="connections"]',
        { reveal: "studio-navigation", icon: "apps" },
      ),
    ];
  if (journey === "board")
    return reader
      ? [
          step(
            "See the whole story",
            "Use Fit board to see everything, then zoom into a detail. Drag blank canvas to move around.",
            "Your board role controls which editing and commenting tools are available.",
            'button[aria-label="Fit board"]',
          ),
          step(
            "Join the conversation",
            "Comments keep the discussion beside the ideas. A commenter can start or reply to a thread; a viewer can read it.",
            "Each comment stays connected to the board.",
            'button[aria-label="Comments"]',
          ),
          step(
            role === "visitor"
              ? "This board has its own invitation"
              : "Find your way home",
            role === "visitor"
              ? "This invitation opens only this board. The home button takes you to Huddle Loom; it does not grant access to the Studio’s other boards."
              : "Back to studio returns to the boards shared with you. Your work here stays saved as you move between pages.",
            "Open Quick tour from board help whenever you need a refresher.",
            ".home-link",
          ),
        ]
      : [
          step(
            "Begin with a sticky note",
            "Drag this icon onto the canvas, or select it and click to place a note. Double-click your note to write.",
            "N selects the sticky tool. Your last color is remembered.",
            '.creation-rail button[aria-label="Sticky note"]',
          ),
          step(
            "Connect one idea to the next",
            "Use a connection line to link notes and shapes. Select a note and its plus handles create the next note with an attached arrow.",
            "Connections stay attached when you move a note.",
            '.creation-rail button[aria-label="Connection line"]',
          ),
          step(
            "Give decisions a shape",
            "Drag your last shape onto the board. The small options button opens the picker for decisions, circles, and other shapes.",
            "S selects Shapes; its options remember your last choice.",
            '.creation-rail button[aria-label="Shapes"]',
          ),
          step(
            "Start from a pattern",
            "Patterns are editable starting points. Try a workshop, a complete update flow, or fifty notes ready for brainstorming.",
            "Adding a pattern keeps the ideas already on your board.",
            'button[aria-label="Patterns (templates)"]',
          ),
          step(
            "Make room for the bigger picture",
            "Fit board brings every idea into view. Drag blank canvas to pan; hold Shift while dragging to select an area instead.",
            "The zoom buttons help you move between the whole story and its details.",
            'button[aria-label="Fit board"]',
          ),
          ...(role === "visitor"
            ? []
            : [
                step(
                  "Build with other people",
                  "Share invites collaborators and controls their access. Choose viewer, commenter, editor, or manager, or enable a guest link.",
                  "A private board stays private until you share it.",
                  ".share-button",
                ),
              ]),
          step(
            "Run a focused huddle",
            "Huddle brings together the timer, brainstorming, and voting. A running timer stays visible when the menu closes.",
            "Use frames and Present to lead people through your board.",
            'button[aria-label="Huddle session tools"]',
          ),
          ...(role === "visitor"
            ? []
            : [
                step(
                  "Your work has a history",
                  "More board options includes Unravel, exports, account settings, and Connected apps. Unravel lets you preview and restore an earlier version.",
                  "Undo is for recent edits; Unravel is for returning to a saved checkpoint.",
                  'summary[aria-label="More board options"]',
                ),
              ]),
        ];
  if (journey === "connections")
    return [
      step(
        "Choose the assistant you use",
        "Select ChatGPT, Claude, or another MCP client. The instructions below change to match your choice.",
        "You connect from your assistant and approve access here.",
        ".connection-client-tabs",
        { icon: "apps" },
      ),
      step(
        "Copy your Studio’s address",
        "This is the MCP server URL to enter in your assistant. It connects to this installation of Huddle Loom.",
        "A local preview cannot be reached by a remote assistant. Use your deployed address.",
        ".connection-endpoint",
      ),
      step(
        "Try a complete workflow",
        "Follow the connection instructions, then copy the example prompt. It asks your assistant to build, lay out, inspect, and refine an editable workflow.",
        "Describe the steps, decisions, and branches you want to see.",
        ".connection-test-prompt > div",
      ),
      step(
        "You choose the boundaries",
        "Review board access and permissions during sign-in. Your assistant uses its own connection and never needs your password.",
        "Read, edit, collaborate, and export are separate permissions.",
        ".connection-permissions h2",
        { icon: "lock" },
      ),
      step(
        "Keep every connection in view",
        "Manage access changes a connected app’s boards and permissions. Disconnect revokes its access whenever you choose.",
        "Connection checks above can help explain a failed setup.",
        ".connected-client-list .connection-list-heading, .connected-client-list h2",
      ),
    ];
  if (journey === "account")
    return [
      step(
        "Make your presence your own",
        "Your name and thread color identify you in shared boards. Keep them recognizable for the people working with you.",
        "Account settings apply to your sign-in, not anyone else’s.",
        ".identity-content > .identity-section:first-of-type button",
      ),
      step(
        "Keep a way back in",
        "Review your sign-in methods and recovery options before removing a provider or changing a security factor.",
        "Store recovery codes somewhere private and separate from this app.",
        ".identity-section",
        { heading: "Sign-in providers", icon: "lock" },
      ),
      step(
        "Know where you are signed in",
        "Devices and sessions shows your active sign-ins. End a session if you no longer recognize or use it.",
        "Recent security activity helps you check changes to your account.",
        ".identity-section",
        { heading: "Devices and sessions", icon: "lock" },
      ),
      step(
        "Your data stays yours",
        "Your data includes export and account deletion controls. Read the confirmation carefully before making a permanent change.",
        "Sharing permissions are managed on each board or workbook.",
        ".identity-section",
        { heading: "Your data" },
      ),
    ];
  const pages: Record<string, TourStep[]> = {
    people: [
      step(
        "Find the right person",
        "Search by name, username, or email. The status filter finds people awaiting approval or accounts that need attention.",
        "Studio roles and board roles are separate.",
        ".identity-toolbar",
      ),
      step(
        "Review access deliberately",
        "Manage opens an account’s status, role, and security actions. The installation owner is protected from these bulk actions.",
        "An administrator still needs a board invitation to access private work.",
        "[data-onboarding=people-list] button, [data-onboarding=people-list] .identity-empty",
      ),
    ],
    invitations: [
      step(
        "Invite without an email service",
        "Create a private invitation link for a new Studio account. The recipient chooses their own username and password.",
        "Share each invitation only with its intended recipient.",
        ".identity-section",
        { heading: "Invite without email", child: "form .identity-field" },
      ),
      step(
        "Track invitations",
        "Search existing email invitations and check their expiry. Revoke an unused invitation when it is no longer needed.",
        "Email invitations need a configured sender; private links work without one.",
        ".identity-toolbar",
      ),
    ],
    "sign-in": [
      step(
        "Choose how your Studio welcomes people",
        "Registration can be closed, invitation only, or public with verified email. Approval and second-factor settings control admission.",
        "Review your recovery method before tightening sign-in requirements.",
        ".identity-section",
        {
          heading: "Registration and security",
          child: "label:has(select)",
          icon: "lock",
        },
      ),
      step(
        "Configure your sign-in providers",
        "Provider settings connect supported identity services. Keep callback addresses and credentials consistent with your deployment.",
        "Changes to security settings can require a fresh confirmation.",
        ".identity-section",
        { heading: "Sign-in providers", child: "button", icon: "lock" },
      ),
    ],
    clients: [
      step(
        "Register a trusted assistant",
        "App clients are the OAuth clients allowed to request access. Register a client here if your installation does not use automatic registration.",
        "A client registration does not grant access to private boards.",
        ".identity-section",
        { heading: "Register a trusted client", child: "button", icon: "apps" },
      ),
    ],
    usage: [
      step(
        "Keep usage within your limits",
        "Usage shows the installation’s current activity. Review limits before changing capacity or inviting a larger group.",
        "Limits protect shared resources for everyone.",
        ".identity-section",
        { heading: "Configured limits" },
      ),
    ],
    activity: [
      step(
        "Follow the security trail",
        "Filter security events to investigate sign-ins, permission changes, and administrative actions.",
        "An event explains what happened; it does not expose private board contents.",
        ".identity-toolbar",
        { icon: "lock" },
      ),
    ],
    updates: [
      step(
        "Know what is installed",
        "Compare the installed version with the latest published release. Check for updates refreshes release information without installing anything.",
        "The owner approves installation; administrators can review the release.",
        ".updates-release-title",
      ),
      step(
        "Choose your update policy",
        "Compatible security patches can be installed automatically when your deployment is connected. Feature releases remain yours to approve.",
        "Compatibility checks protect the database and board format.",
        ".identity-section",
        { heading: "Your update preferences", child: ".identity-check" },
      ),
      step(
        "Connect your deployment",
        "Deployment settings link your installation to its hosting workflow. Follow the instructions for Cloudflare or Node.js.",
        "The connection never changes your board sharing permissions.",
        ".identity-section",
        { heading: "Deployment connection" },
      ),
    ],
    system: [
      step(
        "Check the installation’s health",
        "System summarizes the installation and links to operating instructions. Keep a recovery plan before changing hosting settings.",
        "Backups and recovery protect every person’s work.",
        ".identity-section",
        { heading: "Installation" },
      ),
      step(
        "Make invitations arrive",
        "Review recent email delivery and configure the sender if you want email invitations and recovery messages.",
        "Private invitation links remain available without an email service.",
        ".identity-section",
        { heading: "Recent email delivery" },
      ),
      step(
        "See background work",
        "Background jobs and migrations show operational progress. Use these details when investigating a stalled task.",
        "Read the backup and recovery guide before database changes.",
        ".identity-section",
        { heading: "Background jobs" },
      ),
    ],
  };
  const section = path.split("/").at(-1) ?? "";
  if (section === "updates" && platform !== "cloudflare")
    return [
      step(
        "Keep this app, replace its package",
        "Download the latest Node package and upload it to the same app in your hosting dashboard. Keep its database and setup settings.",
        "Back up the database, stop the previous server, then start its replacement.",
        ".identity-section",
        { heading: "Update through your hosting dashboard" },
      ),
      step(
        "Follow your hosting guide",
        "The Node.js update guide covers the hosting steps and the checks to make after an upgrade.",
        "People on open boards briefly reconnect when the replacement starts.",
        ".updates-panel a",
      ),
    ];
  if (section === "updates" && role === "admin")
    return [
      step(
        "Review the installed release",
        "Check the installed version and review published release information. The Studio owner approves an installation.",
        "Private board permissions are unaffected by checking release information.",
        ".updates-release-title",
      ),
      step(
        "See previous deployments",
        "Deployment history records progress and outcomes. Share this information with your Studio owner when an update needs attention.",
        "Administrators can review updates; deployment changes remain with the owner.",
        ".identity-section",
        { heading: "Deployment history" },
      ),
    ];
  return [
    step(
      "Your administration, in context",
      "This navigation separates account settings from Studio administration. Only sections allowed by your installation role are available.",
      "This guide points out controls. It never changes settings or creates accounts.",
      nav,
    ),
    ...(pages[section] ?? []),
  ];
}
