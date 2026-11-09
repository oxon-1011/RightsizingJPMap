// 右上のデータを追加するボタン。アイコンだけのボタンで、アクセシブルな名前は「データを追加」（Figma の「Button / データを追加」）。
// 押すとファイルの選択を開き、選んだファイルを onFiles に渡す。中身の検査は app が core で行う。

import { useRef } from "react";
import { ACCEPTED_FILE_TYPES } from "./file-drag";
import { UploadIcon } from "./icons";

type AddDataButtonProps = {
  onFiles: (files: readonly File[]) => void;
};

export const AddDataButton = ({ onFiles }: AddDataButtonProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-label="データを追加"
        className={`
          flex size-12 cursor-pointer items-center justify-center rounded-8 bg-white text-key-900 shadow-2
          hover:bg-key-50 active:bg-key-100
          focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-[calc(2/16*1rem)] focus-visible:ring-[calc(2/16*1rem)] focus-visible:ring-yellow-300
        `}
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        multiple={true}
        hidden={true}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          // 同じファイルを続けて選んでも change が起きるよう、選択を空に戻す
          e.currentTarget.value = "";
          if (files.length > 0) {
            onFiles(files);
          }
        }}
      />
    </>
  );
};
