// デジタル庁デザインシステムの React のコード例から取り込んだ（MIT、同じディレクトリの LICENSE）。
// 出所：https://github.com/digital-go-jp/design-system-example-components-react/blob/e637c6820a8ceb5b1c28719e3260afdab89c2b57/src/components/Slot/Slot.tsx
// 変更：整形だけ。

import { Children, cloneElement, type HTMLAttributes, isValidElement, type ReactNode } from "react";

type SlotProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode;
};

export const Slot = (props: SlotProps) => {
  const { children, ...rest } = props;

  // https://react.dev/reference/react/isValidElement
  // https://react.dev/reference/react/cloneElement
  if (isValidElement<HTMLAttributes<HTMLElement>>(children)) {
    return cloneElement(children, {
      ...rest,
      ...children.props,
      className: `${rest.className ?? ""} ${children.props.className ?? ""}`,
    });
  }

  if (Children.count(children) > 1) {
    Children.only(null);
  }

  return null;
};
