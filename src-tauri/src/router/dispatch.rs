use crate::db::models::Channel;

#[derive(Debug, Clone, PartialEq)]
pub struct RouteTarget {
    pub channel: Channel,
    pub model: String,
    pub via_fallback: bool,
}

/// 角色路由候选：一个角色可绑定多个供应商/模型，各自带优先级与权重。
#[derive(Debug, Clone)]
pub struct RoleCandidate {
    pub route_id: String,
    pub channel: Channel,
    pub model: String,
    pub priority: i64,
    pub weight: i64,
}

/// 同 priority 组内按 weight 加权随机（seed 决定可复现）。weight<=0 视为 1。
pub fn weighted_pick(candidates: &[Channel], seed: u64) -> Option<Channel> {
    weighted_pick_generic(candidates, seed, |c| c.weight.max(1) as u64)
}

fn weighted_pick_generic<T: Clone>(
    candidates: &[T],
    seed: u64,
    weight: impl Fn(&T) -> u64,
) -> Option<T> {
    if candidates.is_empty() {
        return None;
    }
    let total: u64 = candidates.iter().map(|c| weight(c).max(1)).sum();
    let mut roll = seed % total;
    for c in candidates {
        let w = weight(c).max(1);
        if roll < w {
            return Some(c.clone());
        }
        roll -= w;
    }
    candidates.last().cloned()
}

/// 按 priority 降序分组，组内按 weight 做带 seed 的加权洗牌，产出有序候选序列。
pub(crate) fn order_by_priority_weight<T: Clone>(
    items: Vec<T>,
    priority: impl Fn(&T) -> i64,
    weight: impl Fn(&T) -> u64,
    id: impl Fn(&T) -> &str,
    seed: u64,
) -> Vec<T> {
    if items.is_empty() {
        return items;
    }
    let mut items = items;
    items.sort_by(|a, b| priority(b).cmp(&priority(a)));
    let mut out = Vec::new();
    let mut s = seed;
    let mut i = 0;
    while i < items.len() {
        let prio = priority(&items[i]);
        let mut group: Vec<T> = Vec::new();
        while i < items.len() && priority(&items[i]) == prio {
            group.push(items[i].clone());
            i += 1;
        }
        let mut g = group;
        while !g.is_empty() {
            if let Some(pick) = weighted_pick_generic(&g, s, &weight) {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1); // LCG 推进
                g.retain(|x| id(x) != id(&pick));
                out.push(pick);
            } else {
                break;
            }
        }
    }
    out
}

/// 规划一次请求的有序候选目标列表。
/// - 角色路由：`role_candidates` 按 priority 分组、组内按 weight 加权随机排序，
///   末尾追加 fallback。熔断过滤由调用方（forwarder）按 route_id 执行。
/// - 普通调度：按 priority 降序、组内 seed 稳定顺序展开 enabled 渠道，model 取映射或原样。
pub fn plan_route(
    role_candidates: &[RoleCandidate],
    fallback: Option<(Channel, String)>,
    normal_channels: &[Channel],
    resolve_model: &dyn Fn(&Channel, &str) -> String,
    request_model: &str,
    seed: u64,
) -> Vec<RouteTarget> {
    // 角色路由优先
    if !role_candidates.is_empty() {
        let mut out: Vec<RouteTarget> = order_by_priority_weight(
            role_candidates.to_vec(),
            |rc| rc.priority,
            |rc| rc.weight.max(0) as u64,
            |rc| rc.route_id.as_str(),
            seed,
        )
        .into_iter()
        .map(|rc| RouteTarget {
            channel: rc.channel,
            model: rc.model,
            via_fallback: false,
        })
        .collect();
        if let Some((fch, fmodel)) = fallback {
            out.push(RouteTarget {
                channel: fch,
                model: fmodel,
                via_fallback: true,
            });
        }
        return out;
    }

    // 普通调度：按 priority 分组、组内按权重做带 seed 的加权洗牌
    let enabled: Vec<Channel> = normal_channels
        .iter()
        .filter(|c| c.enabled)
        .cloned()
        .collect();
    if enabled.is_empty() {
        return Vec::new();
    }
    order_by_priority_weight(
        enabled,
        |c| c.priority,
        |c| c.weight.max(0) as u64,
        |c| c.id.as_str(),
        seed,
    )
    .into_iter()
    .map(|ch| {
        let model = resolve_model(&ch, request_model);
        RouteTarget {
            channel: ch,
            model,
            via_fallback: false,
        }
    })
    .collect()
}

#[cfg(test)]
pub fn tests_helper_channel(id: &str) -> crate::db::models::Channel {
    crate::db::models::Channel {
        id: id.into(),
        name: id.into(),
        supplier: "openai".into(),
        upstream_protocol: "openai-chat".into(),
        base_url: "http://x".into(),
        api_key: "k".into(),
        models: vec![],
        priority: 0,
        weight: 1,
        enabled: true,
        timeout_secs: 60,
        total_calls: 0,
        total_tokens: 0,
        success_rate: 1.0,
        avg_latency_ms: 0,
        created_at: 1,
        updated_at: 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(id: &str, prio: i64, weight: i64) -> Channel {
        Channel {
            id: id.into(),
            name: id.into(),
            supplier: "openai".into(),
            upstream_protocol: "openai-chat".into(),
            base_url: "http://x".into(),
            api_key: "k".into(),
            models: vec![],
            priority: prio,
            weight,
            enabled: true,
            timeout_secs: 60,
            total_calls: 0,
            total_tokens: 0,
            success_rate: 1.0,
            avg_latency_ms: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn identity(_c: &Channel, m: &str) -> String {
        m.to_string()
    }

    fn rc(route_id: &str, channel: Channel, model: &str, priority: i64, weight: i64) -> RoleCandidate {
        RoleCandidate {
            route_id: route_id.into(),
            channel,
            model: model.into(),
            priority,
            weight,
        }
    }

    #[test]
    fn role_route_beats_normal_and_appends_fallback() {
        let role_ch = ch("role-ch", 0, 1);
        let fb_ch = ch("fb-ch", 0, 1);
        let normal = vec![ch("n1", 100, 1)];
        let plan = plan_route(
            &[rc("r1", role_ch, "deepseek-v4-flash", 0, 1)],
            Some((fb_ch, "kimi-k3".into())),
            &normal,
            &identity,
            "claude-sonnet-4",
            42,
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
            &[rc("r1", ch("role-ch", 0, 1), "m", 0, 1)],
            None,
            &[],
            &identity,
            "x",
            1,
        );
        assert_eq!(plan.len(), 1);
    }

    #[test]
    fn role_routes_order_by_priority_then_weight() {
        // 同角色三个候选：高优先级组(10)整体在前，组内按权重随机（b 权重 3 > a 权重 1）
        let plan = plan_route(
            &[
                rc("low", ch("low", 0, 1), "m", 0, 1),
                rc("ha", ch("ha", 10, 1), "m", 10, 1),
                rc("hb", ch("hb", 10, 3), "m", 10, 3),
            ],
            None,
            &[],
            &identity,
            "x",
            1,
        );
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[2].channel.id, "low");
        let first_two: Vec<&str> = plan[..2].iter().map(|t| t.channel.id.as_str()).collect();
        assert!(first_two.contains(&"ha") && first_two.contains(&"hb"));
    }

    #[test]
    fn normal_scheduling_orders_by_priority_then_weight() {
        let normal = vec![ch("low", 0, 1), ch("high", 10, 1), ch("high2", 10, 1)];
        let plan = plan_route(&[], None, &normal, &identity, "gpt-4o", 7);
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
        let plan = plan_route(&[], None, &[off, ch("on", 0, 1)], &identity, "m", 1);
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
        let plan = plan_route(&[], None, &[], &identity, "m", 1);
        assert!(plan.is_empty());
    }
}
