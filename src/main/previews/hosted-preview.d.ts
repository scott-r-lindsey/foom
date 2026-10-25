import type { Session, WebContentsView } from "electron";
import type { PreviewBounds } from "../../shared/previews";

export interface HostedPreview {
  id: string;
  view: WebContentsView;
  partition: Session;
  bounds: PreviewBounds;
  loaded: boolean;
  attached: boolean;
}
