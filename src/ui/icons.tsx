// Figma のファイル（ページ「人口縮減」の「コンポーネント」）のアイコン。
// パスは Figma の MCP が書き出した SVG から写し、色を currentColor にした。
// upload は Material Symbols に似せて Figma で自作したもの（docs/design/ui.md）。
// visibility と trash は Figma の画面で使っているアイコンで、非表示の目は Figma にないので visibility に斜線を足した。
// settings（歯車）は Figma にないので、Material Symbols の線の太さ（1.5px）に似せて自作した。

import { type ComponentProps, useId } from "react";

type IconProps = Omit<ComponentProps<"svg">, "children">;

/** データを追加するボタン（24px）とドロップの覆い（48px）の矢印。どちらも同じ形 */
export const UploadIcon = ({ width = 24, height = 24, ...rest }: IconProps) => (
  <svg aria-hidden={true} fill="none" height={height} viewBox="0 0 24 24" width={width} {...rest}>
    <path
      d="M12 3L17.5 8.5H13.5V15H10.5V8.5H6.5L12 3ZM4 14H6.5V18H17.5V14H20V20.5H4V14Z"
      fill="currentColor"
    />
  </svg>
);

const VISIBILITY_PATH =
  "M12.0008 15.575C13.1341 15.575 14.0964 15.179 14.8878 14.387C15.6798 13.5957 16.0758 12.6333 16.0758 11.5C16.0758 10.3667 15.6798 9.40433 14.8878 8.613C14.0964 7.821 13.1341 7.425 12.0008 7.425C10.8674 7.425 9.90511 7.821 9.11378 8.613C8.32178 9.40433 7.92578 10.3667 7.92578 11.5C7.92578 12.6333 8.32178 13.5957 9.11378 14.387C9.90511 15.179 10.8674 15.575 12.0008 15.575ZM12.0008 14.2C11.2508 14.2 10.6134 13.9373 10.0888 13.412C9.56345 12.8873 9.30078 12.25 9.30078 11.5C9.30078 10.75 9.56345 10.1123 10.0888 9.587C10.6134 9.06233 11.2508 8.8 12.0008 8.8C12.7508 8.8 13.3884 9.06233 13.9138 9.587C14.4384 10.1123 14.7008 10.75 14.7008 11.5C14.7008 12.25 14.4384 12.8873 13.9138 13.412C13.3884 13.9373 12.7508 14.2 12.0008 14.2ZM12.0008 18.5C9.70078 18.5 7.60511 17.8667 5.71378 16.6C3.82178 15.3333 2.43411 13.6333 1.55078 11.5C2.43411 9.36667 3.82178 7.66667 5.71378 6.4C7.60511 5.13333 9.70078 4.5 12.0008 4.5C14.3008 4.5 16.3968 5.13333 18.2888 6.4C20.1801 7.66667 21.5674 9.36667 22.4508 11.5C21.5674 13.6333 20.1801 15.3333 18.2888 16.6C16.3968 17.8667 14.3008 18.5 12.0008 18.5ZM12.0008 17C13.8841 17 15.6134 16.504 17.1888 15.512C18.7634 14.5207 19.9674 13.1833 20.8008 11.5C19.9674 9.81667 18.7634 8.479 17.1888 7.487C15.6134 6.49567 13.8841 6 12.0008 6C10.1174 6 8.38811 6.49567 6.81278 7.487C5.23811 8.479 4.03411 9.81667 3.20078 11.5C4.03411 13.1833 5.23811 14.5207 6.81278 15.512C8.38811 16.504 10.1174 17 12.0008 17Z";

/** 表示しているレイヤーの目 */
export const VisibilityIcon = (props: IconProps) => (
  <svg aria-hidden={true} fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
    <path d={VISIBILITY_PATH} fill="currentColor" />
  </svg>
);

/** 非表示のレイヤーの目。visibility に斜線を重ね、斜線の両側を少し切り抜いて線を見分けやすくする */
export const VisibilityOffIcon = (props: IconProps) => {
  const maskId = useId();
  return (
    <svg aria-hidden={true} fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="white" />
        <path d="M3 2L22 21" stroke="black" strokeWidth="4" strokeLinecap="round" />
      </mask>
      <path d={VISIBILITY_PATH} fill="currentColor" mask={`url(#${maskId})`} />
      <path d="M3 2L22 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
};

/** レイヤーの削除 */
export const TrashIcon = (props: IconProps) => (
  <svg aria-hidden={true} fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
    <path
      d="M7.3077 20.5C6.80898 20.5 6.38302 20.3234 6.02982 19.9702C5.67661 19.617 5.5 19.191 5.5 18.6923V6.00005H4.5V4.50008H8.99997V3.61548H15V4.50008H19.5V6.00005H18.5V18.6923C18.5 19.1975 18.325 19.625 17.975 19.975C17.625 20.325 17.1974 20.5 16.6922 20.5H7.3077ZM17 6.00005H6.99997V18.6923C6.99997 18.7821 7.02883 18.8558 7.08652 18.9135C7.14422 18.9712 7.21795 19.0001 7.3077 19.0001H16.6922C16.7692 19.0001 16.8397 18.968 16.9038 18.9039C16.9679 18.8398 17 18.7693 17 18.6923V6.00005ZM9.40385 17.0001H10.9038V8.00005H9.40385V17.0001ZM13.0961 17.0001H14.5961V8.00005H13.0961V17.0001Z"
      fill="currentColor"
    />
  </svg>
);

/**
 * 背景地図の設定を開く歯車。8つの歯の輪郭と中心の丸を、1.5px の線で描く。
 * 歯の先は半径 9、根元は半径 6.9 で、輪郭は線の外側まで含めて 24px に収まる
 */
const SETTINGS_PATH =
  "M10.21 5.34L10.51 3.12A9 9 0 0 1 13.49 3.12L13.79 5.34A6.9 6.9 0 0 1 15.45 6.02L17.23 4.67A9 9 0 0 1 19.33 6.77L17.98 8.55A6.9 6.9 0 0 1 18.66 10.21L20.88 10.51A9 9 0 0 1 20.88 13.49L18.66 13.79A6.9 6.9 0 0 1 17.98 15.45L19.33 17.23A9 9 0 0 1 17.23 19.33L15.45 17.98A6.9 6.9 0 0 1 13.79 18.66L13.49 20.88A9 9 0 0 1 10.51 20.88L10.21 18.66A6.9 6.9 0 0 1 8.55 17.98L6.77 19.33A9 9 0 0 1 4.67 17.23L6.02 15.45A6.9 6.9 0 0 1 5.34 13.79L3.12 13.49A9 9 0 0 1 3.12 10.51L5.34 10.21A6.9 6.9 0 0 1 6.02 8.55L4.67 6.77A9 9 0 0 1 6.77 4.67L8.55 6.02A6.9 6.9 0 0 1 10.21 5.34Z";

export const SettingsIcon = (props: IconProps) => (
  <svg aria-hidden={true} fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
    <path d={SETTINGS_PATH} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
