//! 熔断器：按角色路由(route)维护 closed/open/half-open 状态。
//! 连续失败达阈值 → open（拒绝所有请求）；冷却期后转 half-open 放行一次探测；
//! 探测成功 → closed 复位，失败 → 重新 open。

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BreakerState {
    Closed,
    Open,
    HalfOpen,
}

impl BreakerState {
    pub fn label(&self) -> &'static str {
        match self {
            BreakerState::Closed => "closed",
            BreakerState::Open => "open",
            BreakerState::HalfOpen => "half_open",
        }
    }
}

pub struct Breaker {
    state: BreakerState,
    failures: u32,
    max_failures: u32,
    cooldown: Duration,
    opened_at: Option<Instant>,
}

impl Breaker {
    pub fn new(max_failures: i64, cooldown_secs: i64) -> Self {
        Breaker {
            state: BreakerState::Closed,
            failures: 0,
            max_failures: max_failures.max(1) as u32,
            cooldown: Duration::from_secs(cooldown_secs.max(1) as u64),
            opened_at: None,
        }
    }

    pub fn state(&self) -> BreakerState {
        // 暴露时把已过冷却期的 open 视为 half-open（允许探测），不改内部态。
        if self.state == BreakerState::Open
            && self
                .opened_at
                .map(|at| at.elapsed() >= self.cooldown)
                .unwrap_or(false)
        {
            BreakerState::HalfOpen
        } else {
            self.state
        }
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// 是否允许本次请求尝试（half-open 放行一次探测）。
    pub fn allow(&mut self) -> bool {
        match self.state {
            BreakerState::Closed | BreakerState::HalfOpen => true,
            BreakerState::Open => {
                if self
                    .opened_at
                    .map(|at| at.elapsed() >= self.cooldown)
                    .unwrap_or(false)
                {
                    self.state = BreakerState::HalfOpen;
                    true
                } else {
                    false
                }
            }
        }
    }

    pub fn record_success(&mut self) {
        self.state = BreakerState::Closed;
        self.failures = 0;
        self.opened_at = None;
    }

    pub fn record_failure(&mut self) {
        if self.state == BreakerState::HalfOpen {
            // 探测失败：立即重新 open
            self.state = BreakerState::Open;
            self.opened_at = Some(Instant::now());
            self.failures = 1;
            return;
        }
        self.failures += 1;
        if self.failures >= self.max_failures {
            self.state = BreakerState::Open;
            self.opened_at = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closes_after_success() {
        let mut b = Breaker::new(3, 60);
        assert_eq!(b.state(), BreakerState::Closed);
        b.record_failure();
        b.record_failure();
        assert_eq!(b.state(), BreakerState::Closed);
        b.record_failure();
        assert_eq!(b.state(), BreakerState::Open);
        assert!(!b.allow());
        b.record_success();
        assert_eq!(b.state(), BreakerState::Closed);
        assert!(b.allow());
    }

    #[test]
    fn opens_after_max_failures() {
        let mut b = Breaker::new(2, 60);
        b.record_failure();
        assert!(b.allow());
        b.record_failure();
        assert_eq!(b.state(), BreakerState::Open);
        assert!(!b.allow());
    }

    #[test]
    fn half_open_after_cooldown_and_reopens_on_failure() {
        let mut b = Breaker::new(2, 60);
        b.record_failure();
        b.record_failure();
        assert_eq!(b.state(), BreakerState::Open);
        assert!(!b.allow());

        // 人为缩短 opened_at 模拟冷却期结束 → half-open 放行探测
        b.opened_at = Some(Instant::now() - Duration::from_secs(61));
        assert_eq!(b.state(), BreakerState::HalfOpen);
        assert!(b.allow());
        b.record_failure();
        assert_eq!(b.state(), BreakerState::Open);
        assert!(!b.allow());
    }

    #[test]
    fn half_open_probe_success_resets() {
        let mut b = Breaker::new(1, 60);
        b.record_failure();
        assert_eq!(b.state(), BreakerState::Open);
        b.opened_at = Some(Instant::now() - Duration::from_secs(61));
        assert!(b.allow());
        b.record_success();
        assert_eq!(b.state(), BreakerState::Closed);
        assert_eq!(b.failures(), 0);
    }
}
