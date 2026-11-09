// 通知の一覧。画面の上の中央に、古い順に重ねる（Figma の「Toast / 取り込めなかった」）。
// DADS の緊急バナーは強すぎるので使わず、白いカードに枠とアイコンを付ける（docs/design/ui.md）。
// 取り込めなかったときは Error の枠にし、満たさなかった条件と行番号、受け入れ条件へのリンクだけを示す。

import type { Notice } from "../core/state/state";
import { Link } from "./dads/Link";
import { NotificationBannerClose } from "./dads/NotificationClose";
import { NotificationBannerIcon, type NotificationBannerType } from "./dads/NotificationIcon";
import { type NoticeTone, noticeText } from "./notice-text";

type NoticeListProps = {
  notices: readonly Notice[];
  /** 受け入れ条件の文書（docs/user/acceptance.md を公開した場所）の URL */
  acceptanceUrl: string;
  onDismiss: (id: number) => void;
};

const TONE_STYLE: Readonly<
  Record<
    NoticeTone,
    { readonly border: string; readonly icon: string; readonly type: NotificationBannerType }
  >
> = {
  error: { border: "border-error-1", icon: "text-error-1", type: "error" },
  warning: { border: "border-warning-yellow-1", icon: "text-warning-yellow-2", type: "warning" },
  info: { border: "border-key-900", icon: "text-key-900", type: "info1" },
};

export const NoticeList = ({ notices, acceptanceUrl, onDismiss }: NoticeListProps) => (
  // 通知が加わったときに読み上げるよう、空でも置いておく
  <div
    aria-live="polite"
    className="pointer-events-none fixed inset-x-4 top-6 z-20 flex flex-col items-center gap-2"
  >
    {notices.map((notice) => {
      const text = noticeText(notice);
      const style = TONE_STYLE[text.tone];
      return (
        <section
          key={notice.id}
          aria-label={text.title}
          className={`pointer-events-auto flex w-140 max-w-full items-start gap-3 rounded-8 border-2 bg-white p-4 shadow-2 ${style.border}`}
        >
          <NotificationBannerIcon
            type={style.type}
            className={`mt-1 size-6 shrink-0 ${style.icon}`}
          />
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <p className="text-std-16B-170 text-solid-gray-800">{text.title}</p>
            {text.details.map((detail) => (
              <p key={detail} className="text-dns-16N-120 text-solid-gray-800">
                {detail}
              </p>
            ))}
            {text.acceptanceLink && (
              <Link
                className="text-dns-16N-120"
                href={acceptanceUrl}
                target="_blank"
                rel="noreferrer"
              >
                受け入れ条件
              </Link>
            )}
          </div>
          <NotificationBannerClose
            label="通知を閉じる"
            labelHidden={true}
            onClick={() => onDismiss(notice.id)}
          />
        </section>
      );
    })}
  </div>
);
