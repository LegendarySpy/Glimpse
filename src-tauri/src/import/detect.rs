use std::path::Path;

use serde::{Deserialize, Serialize};

use super::shared::ImportBundle;
use super::{aqua, handy, superwhisper, wispr};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedApp {
    pub id: String,
    pub name: String,
}

struct Importer {
    id: &'static str,
    name: &'static str,
    detect: fn(&Path) -> bool,
    parse: fn(&Path) -> Result<ImportBundle, String>,
}

const IMPORTERS: &[Importer] = &[
    Importer {
        id: aqua::ID,
        name: aqua::DISPLAY_NAME,
        detect: aqua::detect,
        parse: aqua::parse,
    },
    Importer {
        id: superwhisper::ID,
        name: superwhisper::DISPLAY_NAME,
        detect: superwhisper::detect,
        parse: superwhisper::parse,
    },
    Importer {
        id: wispr::ID,
        name: wispr::DISPLAY_NAME,
        detect: wispr::detect,
        parse: wispr::parse,
    },
    Importer {
        id: handy::ID,
        name: handy::DISPLAY_NAME,
        detect: handy::detect,
        parse: handy::parse,
    },
];

fn importer(id: &str) -> Option<&'static Importer> {
    IMPORTERS.iter().find(|importer| importer.id == id)
}

pub fn detect_apps(home: &Path) -> Vec<DetectedApp> {
    IMPORTERS
        .iter()
        .filter(|importer| (importer.detect)(home))
        .filter_map(|importer| {
            let bundle = parse_app(importer.id, home).ok()?;
            bundle_has_content(&bundle).then(|| DetectedApp {
                id: importer.id.to_string(),
                name: importer.name.to_string(),
            })
        })
        .collect()
}

fn bundle_has_content(bundle: &ImportBundle) -> bool {
    !bundle.dictionary.is_empty()
        || !bundle.replacements.is_empty()
        || !bundle.personalities.is_empty()
        || !bundle.transcripts.is_empty()
        || bundle.smart_shortcut.is_some()
        || bundle.language.is_some()
        || bundle.auto_launch.is_some()
        || bundle.model_hint.is_some()
}

pub fn display_name(id: &str) -> &'static str {
    importer(id).map_or("Unknown app", |importer| importer.name)
}

pub fn parse_app(id: &str, home: &Path) -> Result<ImportBundle, String> {
    let importer = importer(id).ok_or_else(|| format!("Unknown import source: {id}"))?;
    let mut bundle = (importer.parse)(home)?;

    bundle.language = bundle
        .language
        .as_deref()
        .and_then(super::shared::normalize_language);
    bundle.transcript_count = bundle.transcripts.len() as u32;

    Ok(bundle)
}
