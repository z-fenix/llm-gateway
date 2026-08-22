use super::backup::{ConfigBundle, FORMAT, VERSION};
use crate::proxy::state::AppState;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub channels: usize,
    pub api_keys: usize,
    pub role_routes: usize,
    pub role_patterns: usize,
    pub custom_rules: usize,
    pub conflicts: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub overwritten: usize,
}

pub fn parse_bundle(path: &Path) -> Result<ConfigBundle, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let bundle: ConfigBundle =
        serde_json::from_str(&text).map_err(|e| format!("parse config json: {e}"))?;
    if bundle.format != FORMAT {
        return Err("非 llm-gateway 配置文件".into());
    }
    if bundle.version != VERSION {
        return Err(format!("不支持的配置版本 {}", bundle.version));
    }
    Ok(bundle)
}

fn existing_ids(
    state: &AppState,
) -> (
    HashSet<String>,
    HashSet<String>,
    HashSet<String>,
    HashSet<String>,
    HashSet<String>,
) {
    let channels = state
        .repo
        .list_channels()
        .map(|v| v.into_iter().map(|c| c.id).collect())
        .unwrap_or_default();
    let api_keys = state
        .repo
        .list_api_keys()
        .map(|v| v.into_iter().map(|k| k.id).collect())
        .unwrap_or_default();
    let role_routes = state
        .repo
        .list_role_routes()
        .map(|v| v.into_iter().map(|r| r.role).collect())
        .unwrap_or_default();
    let role_patterns = state
        .repo
        .list_role_patterns()
        .map(|v| v.into_iter().map(|p| p.id).collect())
        .unwrap_or_default();
    let custom_rules = state
        .repo
        .list_custom_rules()
        .map(|v| v.into_iter().map(|r| r.id).collect())
        .unwrap_or_default();
    (channels, api_keys, role_routes, role_patterns, custom_rules)
}

pub fn preview(state: &AppState, bundle: &ConfigBundle) -> ImportPreview {
    let (ch, ak, rr, rp, cr) = existing_ids(state);
    let mut conflicts = 0;
    conflicts += bundle
        .channels
        .iter()
        .filter(|c| ch.contains(&c.id))
        .count();
    conflicts += bundle
        .api_keys
        .iter()
        .filter(|k| ak.contains(&k.id))
        .count();
    conflicts += bundle
        .role_routes
        .iter()
        .filter(|r| rr.contains(&r.role))
        .count();
    conflicts += bundle
        .role_patterns
        .iter()
        .filter(|p| rp.contains(&p.id))
        .count();
    let n_custom = bundle
        .security
        .as_ref()
        .map(|s| s.custom_rules.iter().filter(|r| cr.contains(&r.id)).count())
        .unwrap_or(0);
    conflicts += n_custom;
    ImportPreview {
        channels: bundle.channels.len(),
        api_keys: bundle.api_keys.len(),
        role_routes: bundle.role_routes.len(),
        role_patterns: bundle.role_patterns.len(),
        custom_rules: bundle
            .security
            .as_ref()
            .map(|s| s.custom_rules.len())
            .unwrap_or(0),
        conflicts,
    }
}

pub fn import(
    state: &AppState,
    bundle: &ConfigBundle,
    strategy: &str,
) -> Result<ImportResult, String> {
    if strategy != "skip" && strategy != "overwrite" {
        return Err(format!("strategy 须为 skip 或 overwrite, got {strategy}"));
    }
    let overwrite = strategy == "overwrite";
    let (ch, ak, rr, rp, cr) = existing_ids(state);
    let mut res = ImportResult {
        imported: 0,
        skipped: 0,
        overwritten: 0,
    };

    for c in &bundle.channels {
        if ch.contains(&c.id) {
            if overwrite {
                if let Err(e) = state.repo.update_channel(c) {
                    log::error!("import: failed to overwrite channel {}: {}", c.id, e);
                    res.skipped += 1;
                } else {
                    res.overwritten += 1;
                }
            } else {
                res.skipped += 1;
            }
        } else if let Err(e) = state.repo.insert_channel(c) {
            log::error!("import: failed to insert channel {}: {}", c.id, e);
            res.skipped += 1;
        } else {
            res.imported += 1;
        }
    }

    for k in &bundle.api_keys {
        if ak.contains(&k.id) {
            if overwrite {
                if let Err(e) = state.repo.update_api_key(k) {
                    log::error!("import: failed to overwrite api_key {}: {}", k.id, e);
                    res.skipped += 1;
                } else {
                    res.overwritten += 1;
                }
            } else {
                res.skipped += 1;
            }
        } else if let Err(e) = state.repo.insert_api_key(k) {
            log::error!("import: failed to insert api_key {}: {}", k.id, e);
            res.skipped += 1;
        } else {
            res.imported += 1;
        }
    }

    for r in &bundle.role_routes {
        if rr.contains(&r.role) {
            if overwrite {
                if let Err(e) = state.repo.upsert_role_route(r) {
                    log::error!("import: failed to overwrite role_route {}: {}", r.role, e);
                    res.skipped += 1;
                } else {
                    res.overwritten += 1;
                }
            } else {
                res.skipped += 1;
            }
        } else if let Err(e) = state.repo.upsert_role_route(r) {
            log::error!("import: failed to insert role_route {}: {}", r.role, e);
            res.skipped += 1;
        } else {
            res.imported += 1;
        }
    }

    for p in &bundle.role_patterns {
        if rp.contains(&p.id) {
            if overwrite {
                if let Err(e) = state.repo.upsert_role_pattern(p) {
                    log::error!("import: failed to overwrite role_pattern {}: {}", p.id, e);
                    res.skipped += 1;
                } else {
                    res.overwritten += 1;
                }
            } else {
                res.skipped += 1;
            }
        } else if let Err(e) = state.repo.upsert_role_pattern(p) {
            log::error!("import: failed to insert role_pattern {}: {}", p.id, e);
            res.skipped += 1;
        } else {
            res.imported += 1;
        }
    }

    if let Some(sec) = &bundle.security {
        for rule in &sec.custom_rules {
            if cr.contains(&rule.id) {
                if overwrite {
                    if let Err(e) = state.repo.update_custom_rule(rule) {
                        log::error!("import: failed to overwrite custom_rule {}: {}", rule.id, e);
                        res.skipped += 1;
                    } else {
                        res.overwritten += 1;
                    }
                } else {
                    res.skipped += 1;
                }
            } else if let Err(e) = state.repo.create_custom_rule(rule) {
                log::error!("import: failed to insert custom_rule {}: {}", rule.id, e);
                res.skipped += 1;
            } else {
                res.imported += 1;
            }
        }

        if overwrite {
            for br in &sec.builtin_rules {
                if let Err(e) = state
                    .repo
                    .update_builtin_rule(&br.id, br.enabled, &br.severity)
                {
                    log::error!("import: failed to update builtin_rule {}: {}", br.id, e);
                }
            }
        }

        *state.security.write() = sec.settings.clone();
    }

    if let Some(fb) = &bundle.fallback {
        *state.fallback.write() = Some((fb.channel_id.clone(), fb.model.clone()));
    }

    if let Some(ac) = &bundle.app_config {
        let p = ac.preferred_port.clamp(
            crate::config::settings::MIN_PORT,
            crate::config::settings::MAX_PORT,
        );
        *state.app.write() = crate::config::settings::AppConfig { preferred_port: p };
    }

    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::backup::{AppConfigExport, SecurityExport};
    use crate::db::models::{ApiKey, Channel, CustomRule, RoleRoute};
    use crate::db::Db;
    use crate::proxy::state::AppState;
    use crate::security::SecuritySettings;

    fn test_state() -> AppState {
        AppState::new(Db::new_in_memory().unwrap())
    }

    fn test_state_with_channel(id: &str) -> AppState {
        test_state_with_channel_named(id, id)
    }

    fn test_state_with_channel_named(id: &str, name: &str) -> AppState {
        let state = test_state();
        let channel = Channel {
            id: id.into(),
            name: name.into(),
            supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
            base_url: "https://api.openai.com/v1".into(),
            api_key: "sk-test".into(),
            models: vec!["gpt-4o".into()],
            priority: 10,
            weight: 1,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        };
        state.repo.insert_channel(&channel).unwrap();
        state
    }

    fn bundle_with_channel(id: &str) -> ConfigBundle {
        bundle_with_channel_named(id, id)
    }

    fn bundle_with_channel_named(id: &str, name: &str) -> ConfigBundle {
        ConfigBundle {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: 1,
            app_config: None,
            channels: vec![Channel {
                id: id.into(),
                name: name.into(),
                supplier: "openai".into(),
                upstream_protocol: "openai-chat".into(),
                base_url: "https://api.openai.com/v1".into(),
                api_key: "".into(),
                models: vec!["gpt-4o".into()],
                priority: 10,
                weight: 1,
                enabled: true,
                timeout_secs: 60,
                total_calls: 0,
                total_tokens: 0,
                success_rate: 1.0,
                avg_latency_ms: 0,
                created_at: 1,
                updated_at: 1,
            }],
            api_keys: vec![],
            role_routes: vec![],
            role_patterns: vec![],
            fallback: None,
            security: None,
        }
    }

    fn empty_bundle() -> ConfigBundle {
        ConfigBundle {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: 1,
            app_config: None,
            channels: vec![],
            api_keys: vec![],
            role_routes: vec![],
            role_patterns: vec![],
            fallback: None,
            security: None,
        }
    }

    fn bundle_with_overwrite_data() -> ConfigBundle {
        ConfigBundle {
            format: FORMAT.into(),
            version: VERSION,
            exported_at: 1,
            app_config: None,
            channels: vec![],
            api_keys: vec![ApiKey {
                id: "k1".into(),
                key: "sk-imported".into(),
                name: "imported".into(),
                enabled: false,
                quota_total: Some(2000),
                quota_used: 100,
                total_calls: 5,
                total_tokens: 1000,
                created_at: 2,
                last_used_at: Some(2),
            }],
            role_routes: vec![],
            role_patterns: vec![],
            fallback: None,
            security: Some(SecurityExport {
                settings: SecuritySettings::default(),
                builtin_rules: vec![],
                custom_rules: vec![CustomRule {
                    id: "cr1".into(),
                    rule_type: "keyword".into(),
                    category: "secret".into(),
                    pattern: "imported-pattern".into(),
                    severity: "high".into(),
                    action: "block".into(),
                    enabled: false,
                    description: Some("imported desc".into()),
                    created_at: 2,
                }],
            }),
        }
    }

    #[test]
    fn preview_counts_conflicts() {
        let state = test_state_with_channel("c1");
        let bundle = bundle_with_channel("c1");
        let p = preview(&state, &bundle);
        assert_eq!(p.channels, 1);
        assert_eq!(p.conflicts, 1);
    }

    #[test]
    fn import_skip_keeps_existing_overwrite_replaces() {
        let state = test_state_with_channel_named("c1", "old");
        let bundle = bundle_with_channel_named("c1", "new");
        let r = import(&state, &bundle, "skip").unwrap();
        assert_eq!(r.skipped, 1);
        assert_eq!(state.repo.get_channel("c1").unwrap().unwrap().name, "old");
        let r2 = import(&state, &bundle, "overwrite").unwrap();
        assert_eq!(r2.overwritten, 1);
        assert_eq!(state.repo.get_channel("c1").unwrap().unwrap().name, "new");
    }

    #[test]
    fn import_resilient_to_per_record_errors() {
        let state = test_state();
        let mut bundle = bundle_with_channel("good-channel");
        // 引用不存在的 channel，触发外键约束失败。
        bundle.role_routes.push(RoleRoute {
            id: "bad-route".into(),
            role: "bad-role".into(),
            channel_id: "missing-channel".into(),
            target_model: "gpt-4o".into(),
            enabled: true,
            updated_at: 1,
        });

        let r = import(&state, &bundle, "overwrite").unwrap();

        assert_eq!(r.imported, 1);
        assert_eq!(r.skipped, 1);
        assert_eq!(r.overwritten, 0);
        assert!(state.repo.get_channel("good-channel").unwrap().is_some());
        assert!(state.repo.get_role_route("bad-role").unwrap().is_none());
    }

    #[test]
    fn parse_bundle_rejects_bad_version() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.json");
        std::fs::write(&p, r#"{"format":"llm-gateway-config","version":99}"#).unwrap();
        assert!(parse_bundle(&p).is_err());
    }

    #[test]
    fn import_clamps_preferred_port_low() {
        let state = test_state();
        let mut bundle = empty_bundle();
        bundle.app_config = Some(AppConfigExport { preferred_port: 0 });
        import(&state, &bundle, "overwrite").unwrap();
        assert_eq!(
            state.app.read().preferred_port,
            crate::config::settings::MIN_PORT
        );
    }

    #[test]
    fn import_clamps_preferred_port_high() {
        let state = test_state();
        let mut bundle = empty_bundle();
        bundle.app_config = Some(AppConfigExport {
            preferred_port: 9000,
        });
        import(&state, &bundle, "overwrite").unwrap();
        assert_eq!(
            state.app.read().preferred_port,
            crate::config::settings::MAX_PORT
        );
    }

    #[test]
    fn import_overwrite_api_key_and_custom_rule_atomic() {
        let state = test_state();
        state
            .repo
            .insert_api_key(&ApiKey {
                id: "k1".into(),
                key: "sk-old".into(),
                name: "old".into(),
                enabled: true,
                quota_total: Some(100),
                quota_used: 0,
                total_calls: 0,
                total_tokens: 0,
                created_at: 1,
                last_used_at: None,
            })
            .unwrap();
        state
            .repo
            .create_custom_rule(&CustomRule {
                id: "cr1".into(),
                rule_type: "regex".into(),
                category: "prompt_injection".into(),
                pattern: "old-pattern".into(),
                severity: "medium".into(),
                action: "warn".into(),
                enabled: true,
                description: Some("old desc".into()),
                created_at: 1,
            })
            .unwrap();

        let r = import(&state, &bundle_with_overwrite_data(), "overwrite").unwrap();
        assert_eq!(r.imported, 0);
        assert_eq!(r.skipped, 0);
        assert_eq!(r.overwritten, 2);

        let key = state
            .repo
            .get_api_key_by_key("sk-imported")
            .unwrap()
            .unwrap();
        assert_eq!(key.id, "k1");
        assert_eq!(key.name, "imported");
        assert!(!key.enabled);
        assert_eq!(key.quota_total, Some(2000));

        let rules = state.repo.list_custom_rules().unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].id, "cr1");
        assert_eq!(rules[0].pattern, "imported-pattern");
        assert_eq!(rules[0].action, "block");
        assert!(!rules[0].enabled);
    }
}
