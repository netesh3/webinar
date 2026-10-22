from webcaptions.cpuguard import CpuGuard, CpuTimes, GuardMonitor, HostCpuSampler, Level, parse_proc_stat, usage_between


def feed(g, samples, start=0.0, step=2.0):
    t = start
    out = []
    for u in samples:
        out.append(g.observe(u, t))
        t += step
    return out, t


def test_brief_spike_above_high_does_nothing():
    g = CpuGuard()
    levels, _ = feed(g, [90, 90, 90, 50])  # 4-6 s above 85%, not 10
    assert all(l == Level.NORMAL for l in levels)


def test_sustained_high_degrades_after_ten_seconds():
    g = CpuGuard()
    levels, _ = feed(g, [88] * 7)  # samples at 0,2,...,12 s
    assert levels[4] == Level.NORMAL  # t=8 s
    assert levels[5] == Level.DEGRADED  # t=10 s
    assert levels[-1] == Level.DEGRADED


def test_critical_pauses_at_once():
    g = CpuGuard()
    assert g.observe(97, 0) == Level.PAUSED


def test_resume_needs_twenty_quiet_seconds_per_step():
    g = CpuGuard()
    g.observe(99, 0)
    assert g.level == Level.PAUSED
    # 72% is below high but not below low: no recovery.
    levels, t = feed(g, [72] * 20, start=2)
    assert levels[-1] == Level.PAUSED
    levels, t = feed(g, [50] * 11, start=t)  # 0..20 s below 70%
    assert levels[-1] == Level.DEGRADED
    levels, t = feed(g, [50] * 11, start=t)
    assert levels[-1] == Level.NORMAL


def test_quiet_period_restarts_when_load_returns():
    g = CpuGuard()
    feed(g, [90] * 6)
    assert g.level == Level.DEGRADED
    _, t = feed(g, [50] * 8, start=20)  # 14 s quiet
    g.observe(80, t)  # back up (not below low): timer resets
    levels, _ = feed(g, [50] * 8, start=t + 2)
    assert levels[-1] == Level.DEGRADED


def test_paused_does_not_drop_to_degraded_while_still_high():
    g = CpuGuard()
    g.observe(99, 0)
    levels, _ = feed(g, [90] * 20, start=2)
    assert levels[-1] == Level.PAUSED


PROC = """cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
intr 1
"""


def test_parse_proc_stat_counts_iowait_as_idle():
    t = parse_proc_stat(PROC)
    assert t == CpuTimes(busy=150, total=1000)


def test_usage_between_samples():
    a = CpuTimes(busy=150, total=1000)
    b = CpuTimes(busy=250, total=1200)
    assert usage_between(a, b) == 50.0
    assert usage_between(b, b) is None


def test_sampler_reads_a_file(tmp_path):
    p = tmp_path / "stat"
    p.write_text(PROC)
    s = HostCpuSampler(str(p))
    assert s.sample() is None  # first read primes
    p.write_text("cpu  200 0 50 900 50 0 0 0 0 0\n")
    assert s.sample() == 50.0


def test_sampler_without_proc_is_silent(tmp_path):
    assert HostCpuSampler(str(tmp_path / "missing")).sample() is None


def test_monitor_reports_changes(tmp_path):
    p = tmp_path / "stat"
    busy, total = 0, 0

    def write(b, idle):
        nonlocal busy, total
        busy += b
        total += b + idle
        p.write_text(f"cpu  {busy} 0 0 {total - busy} 0 0 0 0\n")

    write(0, 100)
    changes = []
    m = GuardMonitor(CpuGuard(), sampler=HostCpuSampler(str(p)), on_change=lambda o, n: changes.append((o, n)))
    m.sampler.sample()
    write(99, 1)
    assert m.tick(now=0) == Level.PAUSED
    assert changes == [(Level.NORMAL, Level.PAUSED)]
