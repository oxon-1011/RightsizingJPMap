// デジタル庁デザインシステムの React のコード例から取り込んだ（MIT、同じディレクトリの LICENSE）。
// 出所：https://github.com/digital-go-jp/design-system-example-components-react/blob/e637c6820a8ceb5b1c28719e3260afdab89c2b57/src/components/NotificationBanner/parts/Close.tsx
// 変更：
// - 文字を画面に出さずにスクリーンリーダーにだけ伝える labelHidden を足した（Figma の通知は × だけを置く）。
// - Tailwind v4 に合わせて、focus-visible:outline を除き（v4 の outline は幅 1px を指定し、outline-4 と競合する）、
//   v4 のプリフライトがボタンに付けない cursor-pointer を足した。
// - 整形。

import type { ComponentProps } from "react";

type Props = ComponentProps<"button"> & {
  label?: string;
  labelHidden?: boolean;
};

export const NotificationBannerClose = (props: Props) => {
  const { className, label, labelHidden, ...rest } = props;

  return (
    <button
      className={`
        -mr-3 inline-flex items-center self-start gap-1 rounded-6 px-3 pb-1.5 pt-1 text-solid-gray-900 cursor-pointer
        hover:bg-solid-gray-50 hover:underline hover:underline-offset-[calc(3/16*1rem)]
        focus-visible:bg-yellow-300 focus-visible:outline-4 focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:outline-black focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300
        ${className ?? ""}
      `}
      type="button"
      {...rest}
    >
      <svg
        aria-hidden={true}
        className="mt-0.5 size-6"
        fill="none"
        height="24"
        viewBox="0 0 24 24"
        width="24"
      >
        <g>
          <path
            d="m6.4 18.6-1-1 5.5-5.6-5.6-5.6 1.1-1 5.6 5.5 5.6-5.6 1 1.1L13 12l5.6 5.6-1 1L12 13l-5.6 5.6Z"
            fill="currentColor"
          />
        </g>
      </svg>
      <span className={labelHidden ? "sr-only" : "text-oln-16N-100"}>{label ?? "閉じる"}</span>
    </button>
  );
};
