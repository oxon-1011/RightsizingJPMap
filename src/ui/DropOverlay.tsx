// ファイルを地図の上に重ねているあいだの覆い（Figma の「Overlay / ドロップ」）。
// 地図全体をドロップ先にし、DADS のドロップ領域と同じ配色（Green の 50 の背景と Success の破線の枠）で覆う。
// 背景は不透明度 0.6 で、下の地図が透けて見える。ドロップの出来事は window で受けるので、覆いは出来事を受けない。

import { UploadIcon } from "./icons";

type DropOverlayProps = {
  visible: boolean;
};

export const DropOverlay = ({ visible }: DropOverlayProps) =>
  visible ? (
    <div aria-hidden={true} className="pointer-events-none fixed inset-0 z-30">
      <div className="absolute inset-0 bg-green-50 opacity-60" />
      <div className="absolute inset-4 rounded-16 border-3 border-dashed border-success-1" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <UploadIcon className="text-success-1" width={48} height={48} />
        <p className="text-std-18B-160 text-solid-gray-800">ドロップして追加</p>
      </div>
    </div>
  ) : null;
