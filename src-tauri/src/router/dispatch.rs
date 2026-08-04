use crate::db::models::Channel;

#[derive(Debug, Clone, PartialEq)]
pub struct RouteTarget {
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
}

/// 同 priority 组内按 weight 加权随机（seed 决定可复现）。weight<=0 视为 1。
pub fn weighted_pick(candidates: &[Channel], seed: u64) -> Option<Channel> {
    if candidates.is_empty() {
        return None;
    }
    let total: u64 = candidates
        .iter()
        .map(|c| c.weight.max(1) as u64)
        .sum();
    let mut roll = seed % total;
    for c in candidates {
        let w = c.weight.max(1) as u64;
        if roll < w {
            return Some(c.clone());
        }
        roll -= w;
    }
    candidates.last().cloned()
}

/// 规划一次请求的有序候选目标列表。
/// - 角色路由：role_route 给 (channel, model)，候选 = [角色, 兜底?]
/// - 普通调度：按 priority 降序、组内 seed 稳定顺序展开 enabled 渠道，model 取映射或原样
pub fn plan_route(
    role_route: Option<(Channel, String)>,
    fallback: Option<(Channel, String)>,
    normal_channels: &[Channel],
    resolve_model: &dyn Fn(&Channel, &str) -> String,
    request_model: &str,
    seed: u64,
) -> Vec<RouteTarget> {
    // 角色路由优先
    if let Some((ch, model)) = role_route {
        let mut out = vec![RouteTarget {
            channel: ch,
            model,
            via_fallback: false,
        }];
        if let Some((fch, fmodel)) = fallback {
            out.push(RouteTarget {
                channel: fch,
                model: fmodel,
                via_fallback: true,
            });
        }
        return out;
    }

    // 普通调度：按 priority 分组，组内按权重做带 seed 的加权洗牌
    let mut enabled: Vec<Channel> = normal_channels.iter().filter(|c| c.enabled).cloned().collect();
    if enabled.is_empty() {
        return Vec::new();
    }
    enabled.sort_by(|a, b| b.priority.cmp(&a.priority));
    let mut out = Vec::new();
    let mut i = 0;
    let mut s = seed;
    while i < enabled.len() {
        let prio = enabled[i].priority;
        let mut group: Vec<Channel> = Vec::new();
        while i < enabled.len() && enabled[i].priority == prio {
            group.push(enabled[i].clone());
            i += 1;
        }
        // 组内反复 weighted_pick 直到取空，形成有序序列
        let mut g = group;
        while !g.is_empty() {
            if let Some(pick) = weighted_pick(&g, s) {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1); // LCG 推进
                g.retain(|c| c.id != pick.id);
                let model = resolve_model(&pick, request_model);
                out.push(RouteTarget { channel: pick, model, via_fallback: false });
            } else {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
pub fn tests_helper_channel(id: &str) -> crate::db::models::Channel {
    crate::db::models::Channel {
        id: id.into(), name: id.into(), provider_type: "openai".into(),
        base_url: "http://x".into(), api_key: "k".into(), models: vec![],
        priority: 0, weight: 1, enabled: true, timeout_secs: 60,
        total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
        created_at: 1, updated_at: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str, prio: i64, weight: i64) -> Channel {
        Channel {
            id: id.into(), name: id.into(), provider_type: "openai".into(),
            base_url: "http://x".into(), api_key: "k".into(), models: vec![],
            priority: prio, weight, enabled: true, timeout_secs: 60,
            total_calls: 0, total_tokens: 0, success_rate: 1.0, avg_latency_ms: 0,
            created_at: 1, updated_at: 1,
        }
    }

    fn identity(_c: &Channel, m: &str) -> String { m.to_string() }

    #[test]
    fn role_route_beats_normal_and_appends_fallback() {
        let role_ch = ch("role-ch", 0, 1);
        let fb_ch = ch("fb-ch", 0, 1);
        let normal = vec![ch("n1", 100, 1)];
        let plan = plan_route(
            Some((role_ch, "deepseek-v4-flash".into())),
            Some((fb_ch, "kimi-k3".into())),
            &normal, &identity, "claude-sonnet-4", 42,
        );
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].channel.id, "role-ch");
        assert_eq!(plan[0].model, "deepseek-v4-flash");
        assert!(!plan[0].via_fallback);
        assert_eq!(plan[1].channel.id, "fb-ch");
        assert!(plan[1].via_fallback);
    }

    #[test]
    fn role_route_without_fallback_has_single_target() {
        let plan = plan_route(
            Some((ch("role-ch", 0, 1), "m".into())),
            None, &[], &identity, "x", 1,
        );
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn normal_scheduling_orders_by_priority_then_weight() {
        let normal = vec![ch("low", 0, 1), ch("high", 10, 1), ch("high2", 10, 1)];
        let plan = plan_route(None, None, &normal, &identity, "gpt-4o", 7);
        assert_eq!(plan.len(), 3);
        // 高优先级组(10)整体排在低优先级(0)之前
        assert_eq!(plan[2].channel.id, "low");
        let first_two: Vec<&str> = plan[..2].iter().map(|t| t.channel.id.as_str()).collect();
        assert!(first_two.contains(&"high") && first_two.contains(&"high2"));
    }

    #[test]
    fn disabled_channels_excluded() {
        let mut off = ch("off", 100, 1);
        off.enabled = false;
        let plan = plan_route(None, None, &[off, ch("on", 0, 1)], &identity, "m", 1);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].channel.id, "on");
    }

    #[test]
    fn weighted_pick_deterministic_and_weighted() {
        let cands = vec![ch("a", 0, 1), ch("b", 0, 3)];
        // 统计 1000 个不同 seed 的命中分布，b 应显著多于 a
        let mut a = 0;
        let mut b = 0;
        for s in 0..1000u64 {
            match weighted_pick(&cands, s).unwrap().id.as_str() {
                "a" => a += 1,
                _ => b += 1,
            }
        }
        assert!(b > a, "b({}) should exceed a({})", b, a);
    }

    #[test]
    fn empty_when_no_enabled() {
        let plan = plan_route(None, None, &[], &identity, "m", 1);
        assert!(plan.is_empty());
    }
}
