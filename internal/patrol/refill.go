package patrol

import (
	"fmt"
	"time"
)

// evaluateRefill applies the four guards after a successful patrol and, when
// all pass, starts the registration pipeline to top up the pool.
//
// Guards:
//  1. REFILL_ENABLED and healthy < REFILL_MIN_HEALTHY
//  2. cooldown since last refill (REFILL_COOLDOWN_MIN)
//  3. daily cap (REFILL_DAILY_CAP)
//  4. pipeline not currently running
func (s *Service) evaluateRefill(rec *Record) {
	cfg := s.cfgFn()
	if !cfg.RefillEnabled {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	setReason := func(format string, args ...any) {
		s.refill.lastReason = fmt.Sprintf(format, args...)
		s.saveLocked()
	}

	if rec.Healthy >= cfg.RefillMinHealthy {
		return // pool above threshold — nothing to do, no noise
	}

	if s.refill.lastRefill != nil {
		cooldown := time.Duration(max(cfg.RefillCooldownMin, 5)) * time.Minute
		if time.Since(*s.refill.lastRefill) < cooldown {
			setReason("冷却期内（健康 %d < %d，需再等 %s）",
				rec.Healthy, cfg.RefillMinHealthy,
				time.Until(s.refill.lastRefill.Add(cooldown)).Round(time.Minute))
			return
		}
	}

	today := time.Now().Format("2006-01-02")
	count := s.refill.todayCount
	if s.refill.today != today {
		count = 0
	}
	if count >= cfg.RefillDailyCap {
		setReason("已达单日补号上限 %d", cfg.RefillDailyCap)
		return
	}

	if s.pipelineRunning != nil && s.pipelineRunning() {
		setReason("注册任务运行中，跳过补号")
		return
	}

	if s.startPipeline == nil {
		setReason("未配置启动器")
		return
	}

	target := max(cfg.RefillBatch, 1)
	if err := s.startPipeline(target); err != nil {
		setReason("补号启动失败: %v", err)
		return
	}
	now := time.Now()
	s.refill.lastRefill = &now
	s.refill.today = today
	s.refill.todayCount = count + 1
	s.refill.lastReason = fmt.Sprintf("健康 %d < %d，已启动补号 target=%d", rec.Healthy, cfg.RefillMinHealthy, target)
	s.saveLocked()
}
