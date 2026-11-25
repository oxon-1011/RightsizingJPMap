// URL の # 以降に載せる値の名前。URL は `#map=ズーム/緯度/経度&pref=19,20` のようになる。
// 名前を付けるのは、# 以降に複数の値を並べるためである（core の position/hash.ts、region/hash.ts）。

/** 地図の位置。北が上でなければ、経度のあとに向きが続く */
export const POSITION_HASH_NAME = "map";

/** 地域モードの地域。都道府県のコードをカンマで区切る。全国のときは置かない */
export const REGION_HASH_NAME = "pref";
