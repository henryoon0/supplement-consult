-- body-brain refined layer, target: ax-hub Postgres, schema "refined".
-- Not applied yet. Review before running. Source file: data/refined/ingredients.parquet
CREATE SCHEMA IF NOT EXISTS refined;

CREATE TABLE IF NOT EXISTS refined.ingredients (
    canonical_id      text PRIMARY KEY,              -- same as slug
    slug              text NOT NULL UNIQUE,
    name_en           text NOT NULL,
    name_ko           text,
    kind              text NOT NULL CHECK (kind IN ('ingredient', 'protocol', 'topic')),
    aliases_en        text[] NOT NULL DEFAULT '{}',  -- cleaned synonyms, used for transcript search
    aliases_ko        text[] NOT NULL DEFAULT '{}',
    mi_ingredient_id  uuid REFERENCES public.mi_ingredients(id),  -- null for podcast-only rows
    podcast_names     text[] NOT NULL DEFAULT '{}',  -- supplement_mentions.supplement_name values
    mi_aliases_raw    text[] NOT NULL DEFAULT '{}',  -- original mi_ingredients.aliases, unfiltered
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingredients_kind_idx ON refined.ingredients (kind);
CREATE INDEX IF NOT EXISTS ingredients_podcast_names_gin ON refined.ingredients USING gin (podcast_names);

-- One row per supplement_mentions.supplement_name -> canonical row.
CREATE TABLE IF NOT EXISTS refined.podcast_name_map (
    podcast_name  text PRIMARY KEY,
    canonical_id  text NOT NULL REFERENCES refined.ingredients(canonical_id),
    method        text NOT NULL  -- exact_name | normalized_part | alias | manual_override | llm | new_<kind>
);

-- Claim cards extracted from podcast transcripts (pilot: data/refined/pilot_cards.jsonl).
CREATE TABLE IF NOT EXISTS refined.claim_cards (
    id             bigserial PRIMARY KEY,
    topic_slug     text NOT NULL REFERENCES refined.ingredients(canonical_id),
    claim          text NOT NULL,
    speaker        text,
    speaker_role   text CHECK (speaker_role IN ('host', 'guest', 'sponsor_read')),
    kind           text CHECK (kind IN ('mechanism', 'dose_timing', 'caveat', 'anecdote', 'contradiction', 'recommendation')),
    quote          text,
    video_id       text NOT NULL,
    start_seconds  numeric,
    is_ad          boolean NOT NULL DEFAULT false,
    confidence     real CHECK (confidence BETWEEN 0 AND 1),
    extractor      text,           -- model + prompt version
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claim_cards_topic_idx ON refined.claim_cards (topic_slug);
CREATE INDEX IF NOT EXISTS claim_cards_video_idx ON refined.claim_cards (video_id);
