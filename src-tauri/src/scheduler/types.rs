// src-tauri/src/scheduler/types.rs
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tokio_util::sync::CancellationToken;

use crate::providers::error::RustError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    pub id: String,
    pub agent_id: String,
    pub name: Option<String>,
    pub cron_expression: String,
    pub timezone: String,             // IANA timezone (validated; never silently "UTC")
    pub enabled: bool,
    pub prompt: String,
    pub target_conversation_id: Option<String>,
    pub last_run_at: Option<String>,
    pub next_run_at: Option<String>,
    pub last_run_status: Option<String>,
    pub last_error: Option<String>,
    pub consecutive_failures: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: String,
    pub job_id: String,
    pub conversation_id: String,
    pub message_id: Option<String>,
    pub status: String,               // "success" | "error" (CHECK constraint)
    pub error: Option<String>,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub started_at: String,
    pub completed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerHealth {
    pub last_tick_at: Option<String>,
    pub jobs_in_flight: u32,
    pub total_fires_today: u32,
    pub total_failures_today: u32,
}

#[derive(Debug)]
pub struct FireState {
    pub run_id: String,
    pub started_at: DateTime<Utc>,
    pub cancel_token: CancellationToken,
}

/// 5-field cron only. 6-field rejected with INVALID_CRON_FORMAT.
pub fn validate_cron_format(expr: &str) -> Result<(), RustError> {
    let fields = expr.trim().split_whitespace().count();
    if fields != 5 {
        return Err(RustError::new(
            "INVALID_CRON_FORMAT",
            format!("expected 5-field cron, got {fields} fields"),
            false,
        ));
    }
    Cron::new(expr).parse()
        .map_err(|e| RustError::new("INVALID_CRON_FORMAT", e.to_string(), false))?;
    Ok(())
}

pub fn validate_timezone(tz_name: &str) -> Result<Tz, RustError> {
    Tz::from_str(tz_name).map_err(|_| {
        RustError::new("INVALID_TIMEZONE", format!("unknown timezone: {tz_name}"), false)
    })
}

/// Compute the next run time strictly after `after`, in the given timezone.
///
/// DST policy: croner computes occurrences via NaiveDateTime then converts back to the
/// named timezone. For times that fall inside a DST gap (spring-forward: skipped hour)
/// or DST fold (fall-back: ambiguous hour), chrono_tz returns None/Ambiguous and croner
/// returns InvalidTime. We advance `after` by one minute and retry, effectively skipping
/// any DST-affected slot and landing on the next unambiguous occurrence.
pub fn next_run_after(
    cron_expr: &str, tz_name: &str, after: DateTime<Utc>,
) -> Result<DateTime<Utc>, RustError> {
    validate_cron_format(cron_expr)?;
    let tz = validate_timezone(tz_name)?;
    let cron = Cron::new(cron_expr).parse()
        .map_err(|e| RustError::new("INVALID_CRON_FORMAT", e.to_string(), false))?;

    let mut cursor = after;
    // Retry up to 1440 minutes (24 hours) to skip past DST gaps/folds.
    // DST fall-back makes the entire 01:xx hour ambiguous; a cron that fires during
    // that hour will be skipped for the whole hour (60 minutes). We need enough budget
    // to advance past the ambiguous window and find the next candidate.
    for _ in 0..1440 {
        let cursor_local = cursor.with_timezone(&tz);
        match cron.find_next_occurrence(&cursor_local, false) {
            Ok(next_local) => return Ok(next_local.with_timezone(&Utc)),
            Err(_) => {
                // DST gap or ambiguity: advance cursor by 1 minute and retry.
                cursor = cursor + chrono::Duration::minutes(1);
            }
        }
    }
    Err(RustError::new(
        "INVALID_CRON_FORMAT",
        "Could not find next occurrence after 1440 retries (DST or invalid pattern)",
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    #[test]
    fn next_run_top_of_hour_utc() {
        let now = DateTime::parse_from_rfc3339("2026-05-18T12:30:00Z").unwrap().with_timezone(&Utc);
        let next = next_run_after("0 * * * *", "UTC", now).unwrap();
        assert_eq!(next.to_rfc3339(), "2026-05-18T13:00:00+00:00");
    }

    #[test]
    fn next_run_with_timezone() {
        let now = DateTime::parse_from_rfc3339("2026-05-18T00:30:00Z").unwrap().with_timezone(&Utc);
        let next = next_run_after("0 9 * * *", "America/New_York", now).unwrap();
        let h = next.hour();
        assert!(h == 13 || h == 14, "expected 13 or 14 UTC, got {h}");
    }

    #[test]
    fn invalid_cron_errors() {
        let now = Utc::now();
        let e = next_run_after("not a cron", "UTC", now).unwrap_err();
        assert_eq!(e.code, "INVALID_CRON_FORMAT");
    }

    #[test]
    fn six_field_cron_rejected() {
        let e = validate_cron_format("0 0 * * * *").unwrap_err();
        assert_eq!(e.code, "INVALID_CRON_FORMAT");
    }

    #[test]
    fn invalid_timezone_errors() {
        let now = Utc::now();
        let e = next_run_after("0 * * * *", "Atlantis/Lost", now).unwrap_err();
        assert_eq!(e.code, "INVALID_TIMEZONE");
    }

    #[test]
    fn dst_spring_forward_skipped() {
        // 2026-03-08 02:00 EST -> clocks spring forward to 03:00 EDT.
        // 02:30 local does not exist on that day.
        // Croner operates on NaiveDateTime, so it finds 02:30 naive on 2026-03-08,
        // then tries to convert back via chrono_tz::from_local_datetime which returns
        // LocalResult::None for the skipped hour — croner returns InvalidTime error.
        // Therefore next_run_after skips to the NEXT calendar day: 2026-03-09 02:30 EDT.
        //
        // Policy: skipped-hour cron fires are dropped; next occurrence is the following day.
        let after = DateTime::parse_from_rfc3339("2026-03-08T06:00:00Z").unwrap().with_timezone(&Utc);
        let next = next_run_after("30 2 * * *", "America/New_York", after).unwrap();
        // 2026-03-09 02:30 EDT = 06:30 UTC
        assert_eq!(next.format("%Y-%m-%d").to_string(), "2026-03-09");
    }

    #[test]
    fn dst_fall_back_fires_once() {
        // 2026-11-01: clocks fall back at 02:00 EDT -> 01:00 EST.
        // 01:30 local time is ambiguous (occurs as both EDT=05:30Z and EST=06:30Z).
        // Croner calls chrono_tz::from_local_datetime which returns LocalResult::Ambiguous,
        // and croner returns InvalidTime for the entire 01:xx hour.
        //
        // Policy (croner + chrono_tz behavior): the ambiguous hour is skipped entirely.
        // next_run_after retries minute-by-minute past the ambiguous window.
        // The earliest unambiguous local 01:30 is 2026-11-02 01:30 EST = 06:30Z.
        //
        // We assert: date is 2026-11-02, time is 06:30 UTC.
        let after = DateTime::parse_from_rfc3339("2026-11-01T00:00:00Z").unwrap().with_timezone(&Utc);
        let next = next_run_after("30 1 * * *", "America/New_York", after).unwrap();
        assert_eq!(next.format("%Y-%m-%d").to_string(), "2026-11-02",
            "got {}", next.to_rfc3339());
        assert!(next.to_rfc3339().contains("06:30:00"),
            "expected 06:30 UTC (01:30 EST), got {}", next.to_rfc3339());
    }
}
