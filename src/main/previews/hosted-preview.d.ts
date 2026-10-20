import type { Session, WebContentsView } from "electron";
import type { PreviewBounds } from "../../shared/previews";

export interface HostedPreview {
  id: string;
  view: WebContentsView;
  partition: Session;
  bounds: PreviewBounds;
  snapshot?: string;
  snapshotVersion?: number;
  painted?: boolean;
  capturePending?: boolean;
  captureAgain?: boolean;
  refreshTimer?: ReturnType<typeof setTimeout>;
  coverTimer?: ReturnType<typeof setTimeout>;
  coverExpired?: boolean;
  loaded: boolean;
  navigated: boolean;
  previouslyLoaded: boolean;
  attached: boolean;
  clicked: boolean;
  restoreFocus: boolean;
  replacementTimer?: ReturnType<typeof setTimeout>;
  nextReplacementAt: number;
  scroll: [number, number] | undefined;
  readingScroll?: boolean;
}
