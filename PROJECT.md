# Project: Frontend Component Engineering & Architecture Governance

## Architecture
- **UI Base Primitives (`src/components/ui/base/`)**: Atomic, reusable UI primitives (e.g. `Modal.tsx`) strictly decoupled from domain state, React contexts, or business features. Pure UI rendering with portal, keyboard, focus, and animation coordination.
- **Domain Components (`src/components/`)**:
  - `admin/`: Admin dashboard shell and decoupled tab domains (Overview, Users, Orders, Models, Tickets).
  - `ui/topbar/`: Topbar shell and extracted interactive modules (`NodeSearchDialog`, `BoardSelectorDropdown`, `UserDropdown`).
  - `canvas/`: Shared canvas primitives including `ReadOnlyCanvas`.
  - `ui/`: Standard domain modals (`ShareLinkModal`, `RechargeModal`, `FeedbackModal`, `UserProfileModal`, `MySharesModal`, `BoardLibraryModal`).
- **State Management & Hooks (`src/context/`, `src/hooks/`)**:
  - `AuthContext`: Pure user identity, session, login/logout state.
  - `ModalContext`: Dedicated modal visibility and modal parameter management.
  - `useTheme`: Unified dark/light theme persistence and DOM synchronization hook.
- **Architecture Guards (`.dependency-cruiser.cjs`)**:
  - Enforces dependency direction: Base primitives cannot depend on domain components/contexts; utilities cannot depend on UI; contexts/hooks cannot depend on UI components.
- **Testing Infrastructure (`vitest.config.ts`, `src/test/`)**:
  - Vitest + `@testing-library/react` + `happy-dom` for frontend unit/component tests in `src/**/*.test.{ts,tsx}`.
  - Native Node.js runner (`node:test`) for backend integration tests in `tests/*.test.ts`.
  - Unified entry `npm run test` executes both suites cleanly.

---

## Feature Inventory
| # | Feature | Description | Milestone | Status | Source |
|---|---------|-------------|-----------|--------|--------|
| F1 | `Modal` Base Primitive | Reusable modal with React Portal, Escape listener, backdrop click guard, body scroll lock, focus trap, and Framer Motion animation | M-P0 | COMPLETED | ORIGINAL_REQUEST §R1 |
| F2 | Business Modals Migration | Refactor `ShareLinkModal`, `RechargeModal`, `AuthModal`, `FeedbackModal`, `UserProfileModal`, `MySharesModal`, `BoardLibraryModal` to use `Modal` | M-P0 | COMPLETED | ORIGINAL_REQUEST §R1 |
| F3 | Fix `FeedbackModal` Exit Animation | Fix `AnimatePresence` early return bug and restore smooth exit transitions | M-P0 | COMPLETED | ORIGINAL_REQUEST §R1 |
| F4 | Clean Dead Code `QuizPanel.tsx` | Completely remove orphaned `src/components/quiz/QuizPanel.tsx` and ensure 0 references | M-P0 | COMPLETED | ORIGINAL_REQUEST §R1 |
| F5 | Extract `useTheme` Hook | Create `src/hooks/useTheme.ts`, replacing duplicated theme state in `App.tsx` and `SharePage.tsx` | M-P0 | COMPLETED | ORIGINAL_REQUEST §R1 |
| F6 | P0 Stage Review Gate & Report | Perform review gate (Reviewers, Challengers, Auditor) and generate `docs/reviews/P0-REVIEW.md` | M-P0 | COMPLETED | ORIGINAL_REQUEST §R1, R4 |
| F7 | Decompose `AdminDashboardModal` | Split 1800+ lines into Shell + Overview, Users, Orders, Models, Tickets tabs + sub-modals | M-P1 | COMPLETED | ORIGINAL_REQUEST §R2 |
| F8 | Decompose `Topbar` | Extract `NodeSearchDialog`, `BoardSelectorDropdown`, `UserDropdown` from 1200+ line Topbar | M-P1 | COMPLETED | ORIGINAL_REQUEST §R2 |
| F9 | Extract `ReadOnlyCanvas` | Unify duplicated ReactFlow read-only configs from `SharePage` and `SampleBoardViewer` | M-P1 | COMPLETED | ORIGINAL_REQUEST §R2 |
| F10 | P1 Stage Review Gate & Report | Perform review gate (Reviewers, Challengers, Auditor) and generate `docs/reviews/P1-REVIEW.md` | M-P1 | COMPLETED | ORIGINAL_REQUEST §R2, R4 |
| F11 | Frontend Architecture Layering Rules | Add `.dependency-cruiser.cjs` rules for `src/` layering (base UI, utils, contexts, hooks) | M-P2 | COMPLETED | ORIGINAL_REQUEST §R3 |
| F12 | Component Testing Infrastructure | Setup Vitest + `@testing-library/react` + `happy-dom`, integrate with `npm run test` | M-P2 | COMPLETED | ORIGINAL_REQUEST §R3 |
| F13 | Automated Component Unit Tests | Write comprehensive unit tests for `Modal`, `NodeSearchDialog`, and interactions | M-P2 | COMPLETED | ORIGINAL_REQUEST §R3 |
| F14 | `AuthContext` Modal Decoupling | Extract 6 business modals and ticket logic into `ModalContext` and `feedback.ts` | M-P2 | COMPLETED | ORIGINAL_REQUEST §R3 |
| F15 | P2 Stage Review Gate & Report | Perform review gate (Reviewers, Challengers, Auditor) and generate `docs/reviews/P2-REVIEW.md` | M-P2 | COMPLETED | ORIGINAL_REQUEST §R3, R4 |
| F16 | Final Victory Verification | Final verification across all acceptance criteria and summary report | M-P3 | COMPLETED | ORIGINAL_REQUEST §Acceptance |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M-P0 | P0: UI Primitives & Cleanup | F1, F2, F3, F4, F5, F6 | None | COMPLETED |
| M-P1 | P1: Monolith Decomposition | F7, F8, F9, F10 | M-P0 | COMPLETED |
| M-P2 | P2: Arch Guards, Tests & Decoupling | F11, F12, F13, F14, F15 | M-P1 | COMPLETED |
| M-P3 | P3: Final Closure & Reporting | F16 | M-P2 | COMPLETED |

---

## Interface Contracts

### 1. `Modal` Base Primitive (`src/components/ui/base/Modal.tsx`)
```typescript
export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  closeOnEsc?: boolean;       // default: true
  closeOnBackdrop?: boolean;  // default: true
  showCloseButton?: boolean;  // default: true
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}
```

### 2. `useTheme` Hook (`src/hooks/useTheme.ts`)
```typescript
export type Theme = 'light' | 'dark';

export interface UseThemeOptions {
  onToggleNotice?: (nextTheme: Theme) => void;
}

export interface UseThemeReturn {
  theme: Theme;
  isDark: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}
```

### 3. `ReadOnlyCanvas` (`src/components/canvas/ReadOnlyCanvas.tsx`)
```typescript
export interface ReadOnlyCanvasProps {
  nodes: Node[];
  edges: Edge[];
  fitViewPadding?: number;
  className?: string;
  backgroundVariant?: BackgroundVariant;
  ensureAuthProvider?: boolean; // wraps AuthProvider if needed
}
```

### 4. `Topbar` Sub-components (`src/components/ui/topbar/`)
- `NodeSearchDialog`:
  ```typescript
  export interface NodeSearchDialogProps {
    isOpen: boolean;
    onClose: () => void;
    boardId?: string;
    onSelectNode: (nodeId: string) => void;
  }
  ```
- `BoardSelectorDropdown`:
  ```typescript
  export interface BoardSelectorDropdownProps {
    boards: CanvasSummary[];
    activeBoardId: string;
    folders: FolderInfo[];
    onSelectBoard: (boardId: string) => void;
    onRenameBoard: (boardId: string, title: string) => void;
    onDeleteBoard: (boardId: string) => void;
    onNewBoard: () => void;
    onOpenSamples: () => void;
    onOpenLibrary: () => void;
  }
  ```
- `UserDropdown`:
  ```typescript
  export interface UserDropdownProps {
    onOpenIntroduce: () => void;
  }
  ```

### 5. `ModalContext` (`src/context/ModalContext.tsx`)
```typescript
export interface ModalContextValue {
  // Auth Modal
  authModalOpen: boolean;
  authModalMode: 'signin' | 'signup';
  openAuthModal: (mode?: 'signin' | 'signup') => void;
  closeAuthModal: () => void;
  // User Profile Modal
  userProfileModalOpen: boolean;
  openUserProfileModal: () => void;
  closeUserProfileModal: () => void;
  // Feedback Modal
  feedbackModalOpen: boolean;
  openFeedbackModal: () => void;
  closeFeedbackModal: () => void;
  // Recharge Modal
  rechargeModalOpen: boolean;
  rechargeCanvasId?: string;
  upgradeModalReason?: string;
  openRechargeModal: (canvasId?: string, reason?: string) => void;
  closeRechargeModal: () => void;
  // Admin Modal
  adminModalOpen: boolean;
  openAdminModal: () => void;
  closeAdminModal: () => void;
  // My Shares Modal
  mySharesModalOpen: boolean;
  openMySharesModal: () => void;
  closeMySharesModal: () => void;
}
```

---

## Code Layout
```
src/
├── components/
│   ├── ui/
│   │   ├── base/
│   │   │   └── Modal.tsx                # Base modal primitive
│   │   ├── topbar/
│   │   │   ├── NodeSearchDialog.tsx     # Extracted full-text search
│   │   │   ├── BoardSelectorDropdown.tsx# Extracted board selector
│   │   │   └── UserDropdown.tsx         # Extracted user profile menu
│   │   ├── FeedbackModal.tsx            # Migrated to Modal primitive
│   │   ├── ShareLinkModal.tsx           # Migrated to Modal primitive
│   │   ├── RechargeModal.tsx            # Migrated to Modal primitive
│   │   ├── UserProfileModal.tsx         # Migrated to Modal primitive
│   │   ├── MySharesModal.tsx            # Migrated to Modal primitive
│   │   └── BoardLibraryModal.tsx        # Migrated to Modal primitive
│   ├── admin/
│   │   ├── AdminDashboardModal.tsx      # Orchestrator shell
│   │   ├── tabs/
│   │   │   ├── AdminOverviewTab.tsx
│   │   │   ├── AdminUsersTab.tsx
│   │   │   ├── AdminOrdersTab.tsx
│   │   │   ├── AdminModelsTab.tsx
│   │   │   └── AdminTicketsTab.tsx
│   │   ├── modals/
│   │   │   ├── VipGrantModal.tsx
│   │   │   └── UserEmailModal.tsx
│   │   └── shared/
│   │       └── ModelWarningBanner.tsx
│   ├── auth/
│   │   └── AuthModal.tsx                # Migrated to Modal primitive
│   └── canvas/
│       └── ReadOnlyCanvas.tsx           # Extracted read-only canvas wrapper
├── hooks/
│   └── useTheme.ts                      # Unified dark/light theme hook
├── context/
│   ├── AuthContext.tsx                  # Pure authentication & session
│   └── ModalContext.tsx                 # Business modal state
└── test/
    ├── setup.ts                         # Vitest DOM & mock setup
    └── components/                      # Component unit tests
docs/
└── reviews/
    ├── P0-REVIEW.md                     # P0 stage review gate report
    ├── P1-REVIEW.md                     # P1 stage review gate report
    └── P2-REVIEW.md                     # P2 stage review gate report
```
