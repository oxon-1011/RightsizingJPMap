-- places.json を検証する。要素は src/core/data/schema.ts の Place。条件を満たさないと error() で止まる。

CREATE MACRO must(ok, msg) AS CASE WHEN ok THEN 'ok' ELSE error('検証に失敗：' || msg) END;

-- 型を決めずに読み、キーと値の型をそのまま確かめる
CREATE TEMP TABLE raw AS
SELECT unnest(j::JSON[]) AS p
FROM read_json_objects(getvariable('out_dir') || '/places.json', format = 'unstructured') AS t(j);

CREATE TEMP TABLE places AS
SELECT p->>'code' AS code, p->>'name' AS name, p->>'pref_name' AS pref_name, p->>'kind' AS kind,
       (p->'bbox')::DOUBLE[] AS bbox
FROM raw;

CREATE TEMP TABLE municipal AS
SELECT DISTINCT code, name, pref_name, area_type
FROM read_parquet(getvariable('out_dir') || '/municipal_indicators.parquet');

SELECT 'places: 要素は code、name、pref_name、kind、bbox だけを持ち、値の型が契約どおり' AS "check",
  count(*)::VARCHAR AS value,
  must(
    bool_and(
      json_keys(p) = ['code', 'name', 'pref_name', 'kind', 'bbox']
      AND json_type(p->'code') = 'VARCHAR' AND json_type(p->'name') = 'VARCHAR'
      AND json_type(p->'pref_name') = 'VARCHAR' AND json_type(p->'kind') = 'VARCHAR'
      AND json_type(p->'bbox') = 'ARRAY' AND json_array_length(p->'bbox') = 4
      AND list_bool_and(list_transform(json_extract(p, '$.bbox[*]'),
                                       lambda v: json_type(v) IN ('DOUBLE', 'UBIGINT', 'BIGINT')))
    ),
    'places.json の要素の形が契約と違う'
  ) AS result
FROM raw
UNION ALL
SELECT 'places: code は5桁の数字で重複せず、kind は4種類のどれか',
  string_agg(DISTINCT kind, '、'),
  must(
    count(*) = count(DISTINCT code)
    AND bool_and(regexp_full_match(code, '[0-9]{5}') AND name <> '' AND pref_name <> '')
    AND bool_and(kind IN ('prefecture', 'designated-city', 'ward', 'municipality')),
    'code か kind が違う'
  )
FROM places
UNION ALL
SELECT 'places: 件数（都道府県 47、政令指定都市 20、区 171）',
  (SELECT string_agg(kind || ':' || n, '、' ORDER BY kind)
   FROM (SELECT kind, count(*) AS n FROM places GROUP BY kind)),
  must(
    (SELECT count(*) FROM places WHERE kind = 'prefecture') = 47
    AND (SELECT count(*) FROM places WHERE kind = 'designated-city') = 20
    AND (SELECT count(*) FROM places WHERE kind = 'ward') = 171,
    '種類ごとの件数が違う'
  )
UNION ALL
SELECT 'places: bbox は [西, 南, 東, 北] の順で、日本の範囲に収まる',
  min(bbox[1])::VARCHAR || ', ' || min(bbox[2]) || ', ' || max(bbox[3]) || ', ' || max(bbox[4]),
  must(
    bool_and(bbox[1] < bbox[3] AND bbox[2] < bbox[4]
             AND bbox[1] >= 122 AND bbox[3] <= 154 AND bbox[2] >= 20 AND bbox[4] <= 46),
    'bbox の順か範囲が違う'
  )
FROM places
UNION ALL
SELECT 'places: 都道府県と政令指定都市の code は推計と一致し、名前も同じ',
  NULL,
  must(
    (SELECT list(code || name ORDER BY code) FROM places WHERE kind = 'prefecture')
      = (SELECT list(code || name ORDER BY code) FROM municipal WHERE area_type = 'a')
    AND (SELECT list(code || name ORDER BY code) FROM places WHERE kind = 'designated-city')
      = (SELECT list(code || name ORDER BY code) FROM municipal WHERE area_type = '1'),
    '都道府県か政令指定都市の code が推計と違う'
  )
UNION ALL
SELECT 'places: 区は推計の area_type 0 から東京都の特別区を除いたもの。特別区は municipality',
  NULL,
  must(
    (SELECT list(code || name ORDER BY code) FROM places WHERE kind = 'ward')
      = (SELECT list(code || name ORDER BY code) FROM municipal WHERE area_type = '0' AND code NOT LIKE '13%')
    AND (SELECT count(*) FROM places WHERE code BETWEEN '13101' AND '13123' AND kind = 'municipality') = 23,
    '区か特別区の扱いが違う'
  )
UNION ALL
SELECT 'places: 浜通り地域は構成市町村で載せ、07999 と所属未定地は載せない',
  (SELECT count(*) FROM places WHERE code IN ('07204', '07209', '07212', '07541', '07542', '07543', '07544',
                                               '07545', '07546', '07547', '07548', '07561', '07564'))::VARCHAR,
  must(
    (SELECT count(*) FROM places WHERE code IN ('07204', '07209', '07212', '07541', '07542', '07543', '07544',
                                                 '07545', '07546', '07547', '07548', '07561', '07564')) = 13
    AND (SELECT count(*) FROM places WHERE code = '07999') = 0
    AND (SELECT count(*) FROM places WHERE code LIKE '__000' AND kind <> 'prefecture') = 0,
    '浜通り地域か所属未定地の扱いが違う'
  )
UNION ALL
SELECT 'places: 推計の塗る単位（07999 を除く）はすべて載っている',
  NULL,
  must(
    (SELECT count(*) FROM municipal m ANTI JOIN places p USING (code)
     WHERE m.area_type IN ('0', '2', '3') ) = 0,
    '載っていない区市町村がある'
  )
UNION ALL
SELECT 'places: 区の名前は政令指定都市の名前で始まり、市の範囲は区の範囲を囲む',
  NULL,
  must(
    (SELECT bool_and(starts_with(w.name, c.name)
                     AND c.bbox[1] <= w.bbox[1] AND c.bbox[2] <= w.bbox[2]
                     AND c.bbox[3] >= w.bbox[3] AND c.bbox[4] >= w.bbox[4])
            AND count(DISTINCT c.code) = 20 AND count(*) = 171
     FROM places w
     JOIN places c ON c.kind = 'designated-city' AND c.pref_name = w.pref_name AND starts_with(w.name, c.name)
     WHERE w.kind = 'ward'),
    '区と政令指定都市の対応が違う'
  )
UNION ALL
SELECT 'places: pref_name は code の上2桁の都道府県で、都道府県の範囲は県内の候補を囲む',
  NULL,
  must(
    (SELECT bool_and(p.pref_name = f.name
                     AND f.bbox[1] <= p.bbox[1] AND f.bbox[2] <= p.bbox[2]
                     AND f.bbox[3] >= p.bbox[3] AND f.bbox[4] >= p.bbox[4])
     FROM places p JOIN places f ON f.kind = 'prefecture' AND left(f.code, 2) = left(p.code, 2)),
    'pref_name か都道府県の範囲が違う'
  );
