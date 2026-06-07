"""
tests/test_utils.py
單元測試：針對 main.py 中的純函式
執行方式：pytest tests/ -v
"""
import pytest
import pandas as pd
import numpy as np
from main import roc_to_ad, format_pvalue, check_monthly_completeness, classify_weekday, classify_peak


# ──────────────────────────────────────────────
# roc_to_ad
# ──────────────────────────────────────────────

class TestRocToAd:
    def test_normal_conversion(self):
        """民國年 < 200 → 加 1911"""
        s = pd.Series([114, 115])
        assert list(roc_to_ad(s)) == [2025, 2026]

    def test_already_ad(self):
        """年份 >= 200 視為西元年，不加 1911"""
        s = pd.Series([2025])
        assert list(roc_to_ad(s)) == [2025]

    def test_boundary_lower(self):
        """民國 199 → 西元 2110"""
        s = pd.Series([199])
        assert list(roc_to_ad(s)) == [2110]

    def test_boundary_upper(self):
        """民國 200 → 視為西元年，保持 200"""
        s = pd.Series([200])
        assert list(roc_to_ad(s)) == [200]

    def test_single_year(self):
        s = pd.Series([100])
        assert list(roc_to_ad(s)) == [2011]

    def test_empty_series(self):
        s = pd.Series([], dtype=int)
        assert list(roc_to_ad(s)) == []

    def test_returns_series(self):
        result = roc_to_ad(pd.Series([110]))
        assert isinstance(result, pd.Series)

    def test_dtype_is_numeric(self):
        result = roc_to_ad(pd.Series([110, 111]))
        assert pd.api.types.is_numeric_dtype(result)


# ──────────────────────────────────────────────
# format_pvalue
# ──────────────────────────────────────────────

class TestFormatPvalue:
    def test_highly_significant_three_stars(self):
        """p < 0.001 → *** 出現在回傳字串中"""
        assert "***" in format_pvalue(0.0001)

    def test_significant_two_stars(self):
        """0.001 ≤ p < 0.01 → ** 但不含 ***"""
        result = format_pvalue(0.005)
        assert "**" in result
        assert "***" not in result

    def test_marginally_significant_one_star(self):
        """0.01 ≤ p < 0.05 → * 但不含 **"""
        result = format_pvalue(0.03)
        assert "*" in result
        assert "**" not in result

    def test_not_significant_no_star(self):
        """p ≥ 0.05 → 無星號"""
        assert "*" not in format_pvalue(0.1)

    def test_exact_001_boundary(self):
        """p = 0.001 剛好在邊界，應視為 **（< 0.01）"""
        result = format_pvalue(0.001)
        assert "**" in result
        assert "***" not in result

    def test_exact_005_boundary(self):
        """p = 0.05 剛好在邊界，應視為不顯著"""
        assert "*" not in format_pvalue(0.05)

    def test_returns_string(self):
        assert isinstance(format_pvalue(0.01), str)

    def test_zero_pvalue(self):
        """p = 0.0 極端情況應視為極顯著"""
        assert "***" in format_pvalue(0.0)


# ──────────────────────────────────────────────
# check_monthly_completeness
# ──────────────────────────────────────────────

class TestCheckMonthlyCompleteness:

    @pytest.fixture
    def low_month_df(self):
        """5月件數異常偏低，模擬資料不完整"""
        return pd.DataFrame({
            "月份": [1, 1, 2, 2, 3, 3, 5, 5],
            "性別": ["男", "女"] * 4,
            "件數": [20000, 15000, 19000, 14000, 21000, 16000, 100, 80],
        })

    @pytest.fixture
    def normal_df(self):
        """正常月份資料（1-12月，件數均等）"""
        rows = []
        for month in range(1, 13):
            rows.append({"月份": month, "性別": "男", "件數": 20000})
            rows.append({"月份": month, "性別": "女", "件數": 15000})
        return pd.DataFrame(rows)

    def test_flags_low_month(self, low_month_df):
        """件數異常低的月份應被標記"""
        result = check_monthly_completeness(low_month_df, threshold=0.2)
        assert 5 in result

    def test_no_flag_on_normal_data(self, normal_df):
        """正常資料不應有任何月份被標記"""
        result = check_monthly_completeness(normal_df, threshold=0.2)
        assert len(result) == 0

    def test_returns_list(self, low_month_df):
        """回傳型別為 list"""
        result = check_monthly_completeness(low_month_df, threshold=0.2)
        assert isinstance(result, list)

    def test_elements_are_int(self, low_month_df):
        """回傳清單中的元素應為整數"""
        result = check_monthly_completeness(low_month_df, threshold=0.2)
        assert all(isinstance(m, int) for m in result)

    def test_stricter_threshold_flags_more(self, normal_df):
        """更嚴格的門檻（更高的 threshold）應標記更多月份"""
        loose = check_monthly_completeness(normal_df, threshold=0.05)
        strict = check_monthly_completeness(normal_df, threshold=0.99)
        assert len(strict) >= len(loose)

    def test_all_months_equal_no_flag(self):
        """所有月份件數完全相同 → 不應標記任何月份"""
        rows = [{"月份": m, "性別": "男", "件數": 10000} for m in range(1, 13)]
        rows += [{"月份": m, "性別": "女", "件數": 8000} for m in range(1, 13)]
        df = pd.DataFrame(rows)
        result = check_monthly_completeness(df, threshold=0.2)
        assert len(result) == 0

    def test_multiple_low_months(self):
        """多個異常月份都應被標記"""
        df = pd.DataFrame({
            "月份": [1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
            "性別": ["男", "女"] * 5,
            "件數": [20000, 15000, 19000, 14000, 21000, 16000, 50, 40, 60, 45],
        })
        result = check_monthly_completeness(df, threshold=0.2)
        assert 4 in result
        assert 5 in result

    def test_too_few_months_returns_empty(self):
        """月份數 < 4 時，無法判斷，回傳空清單"""
        df = pd.DataFrame({
            "月份": [1, 2, 3],
            "性別": ["男", "男", "男"],
            "件數": [100, 100, 1],
        })
        result = check_monthly_completeness(df, threshold=0.2)
        assert result == []


# ──────────────────────────────────────────────
# [v2.3] classify_weekday
# ──────────────────────────────────────────────

class TestClassifyWeekday:
    def test_saturday_is_holiday(self):
        """週六 → 假日"""
        dates = pd.Series(["2025-01-04"])  # 星期六
        result = classify_weekday(dates)
        assert result[0] == "假日"

    def test_sunday_is_holiday(self):
        """週日 → 假日"""
        dates = pd.Series(["2025-01-05"])  # 星期日
        result = classify_weekday(dates)
        assert result[0] == "假日"

    def test_monday_is_weekday(self):
        """週一 → 平日"""
        dates = pd.Series(["2025-01-06"])  # 星期一
        result = classify_weekday(dates)
        assert result[0] == "平日"

    def test_friday_is_weekday(self):
        """週五 → 平日"""
        dates = pd.Series(["2025-01-10"])  # 星期五
        result = classify_weekday(dates)
        assert result[0] == "平日"

    def test_returns_series(self):
        result = classify_weekday(pd.Series(["2025-01-06"]))
        assert isinstance(result, pd.Series)

    def test_mixed_dates(self):
        """混合平日假日"""
        dates = pd.Series(["2025-01-06", "2025-01-04"])  # 週一、週六
        result = list(classify_weekday(dates))
        assert result[0] == "平日"
        assert result[1] == "假日"

    def test_invalid_date_returns_nan_or_none(self):
        """無法解析的日期應不引發 exception"""
        dates = pd.Series(["not-a-date"])
        result = classify_weekday(dates)
        assert result is not None  # 至少不應 crash


# ──────────────────────────────────────────────
# [v2.3] classify_peak
# ──────────────────────────────────────────────

class TestClassifyPeak:
    @pytest.mark.parametrize("hour", [7, 8, 9])
    def test_morning_peak(self, hour):
        """早上 07-09 時為尖峰"""
        result = classify_peak(pd.Series([hour]))
        assert result[0] == "尖峰"

    @pytest.mark.parametrize("hour", [17, 18, 19])
    def test_evening_peak(self, hour):
        """傍晚 17-19 時為尖峰"""
        result = classify_peak(pd.Series([hour]))
        assert result[0] == "尖峰"

    @pytest.mark.parametrize("hour", [0, 3, 6, 10, 14, 16, 20, 23])
    def test_off_peak(self, hour):
        """其他時段為離峰"""
        result = classify_peak(pd.Series([hour]))
        assert result[0] == "離峰"

    def test_none_input_returns_none(self):
        """NaN 輸入應回傳 None，不引發 exception"""
        result = classify_peak(pd.Series([float("nan")]))
        assert result[0] is None

    def test_returns_series(self):
        result = classify_peak(pd.Series([8]))
        assert isinstance(result, pd.Series)

    def test_boundary_hour_6(self):
        """06 時不是尖峰（尖峰從 07 開始）"""
        result = classify_peak(pd.Series([6]))
        assert result[0] == "離峰"

    def test_boundary_hour_10(self):
        """10 時不是早尖峰"""
        result = classify_peak(pd.Series([10]))
        assert result[0] == "離峰"
