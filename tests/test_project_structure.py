"""
tests/test_project_structure.py

Repository 結構測試：
確認期末專題需要的 Docker、AWS、SaaS Dashboard、GitHub Actions CI/CD
關鍵檔案與關鍵內容是否存在。

執行方式：
    pytest tests/ -v
"""

from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def read_text(relative_path: str) -> str:
    """讀取專案文字檔，統一使用 UTF-8。"""
    path = PROJECT_ROOT / relative_path
    return path.read_text(encoding="utf-8")


# ──────────────────────────────────────────────
# 基本檔案結構
# ──────────────────────────────────────────────

class TestBasicProjectStructure:
    def test_required_root_files_exist(self):
        """專案根目錄應包含核心檔案。"""
        required_files = [
            "main.py",
            "Dockerfile",
            "requirements.txt",
            "README.md",
        ]

        for file_path in required_files:
            assert (PROJECT_ROOT / file_path).is_file(), f"Missing {file_path}"

    def test_required_web_files_exist(self):
        """web/ 應包含前端 Dashboard 核心檔案。"""
        required_files = [
            "web/index.html",
            "web/app.js",
            "web/style.css",
        ]

        for file_path in required_files:
            assert (PROJECT_ROOT / file_path).is_file(), f"Missing {file_path}"

    def test_required_cloud_directories_exist(self):
        """專案應包含 GitHub Actions、AWS、tests 目錄。"""
        required_dirs = [
            ".github/workflows",
            "aws",
            "tests",
        ]

        for dir_path in required_dirs:
            assert (PROJECT_ROOT / dir_path).is_dir(), f"Missing {dir_path}"


# ──────────────────────────────────────────────
# SaaS Dashboard 前端功能
# ──────────────────────────────────────────────

class TestSaaSFrontend:
    def test_index_html_contains_saas_dashboard_elements(self):
        """index.html 應包含 SaaS Dashboard 動態互動元素。"""
        html = read_text("web/index.html")

        required_ids = [
            "subscriber-count",
            "subscriber-delta",
            "subscription-status",
            "subscription-email",
            "notification-list",
            "notification-count",
            "activity-list",
            "api-status",
            "app-mode",
            "connectivity-status",
            "health-check-btn",
        ]

        for element_id in required_ids:
            assert element_id in html, f"Missing HTML element id: {element_id}"

    def test_app_js_contains_saas_services(self):
        """app.js 應包含 SaaS service layer。"""
        js = read_text("web/app.js")

        required_keywords = [
            "const CONFIG",
            "class ReactiveState",
            "const StorageService",
            "const SubscriptionService",
            "const NotificationService",
            "const ActivityLogService",
            "const SystemService",
            "Demo / Production Mode",
            "subscribeProduction",
            "subscribeDemo",
        ]

        for keyword in required_keywords:
            assert keyword in js, f"Missing app.js keyword: {keyword}"

    def test_style_css_contains_saas_styles(self):
        """style.css 應包含 SaaS UI 樣式。"""
        css = read_text("web/style.css")

        required_classes = [
            ".saas-overview",
            ".saas-card",
            ".dashboard-grid",
            ".event-list",
            ".status-pill",
            ".connectivity",
            ".toast-container",
            ".toast",
            ".subscriber-preview",
            ".mini-list",
        ]

        for class_name in required_classes:
            assert class_name in css, f"Missing CSS class: {class_name}"


# ──────────────────────────────────────────────
# Docker / ETL
# ──────────────────────────────────────────────

class TestDockerAndETL:
    def test_dockerfile_exists_and_uses_python(self):
        """Dockerfile 應存在，且應以 Python 環境封裝 ETL。"""
        dockerfile = read_text("Dockerfile")

        assert "FROM" in dockerfile
        assert "python" in dockerfile.lower()
        assert "COPY" in dockerfile
        assert "CMD" in dockerfile or "ENTRYPOINT" in dockerfile

    def test_main_py_contains_etl_output_logic(self):
        """main.py 應包含輸出資料或 Dashboard 產生邏輯。"""
        main_py = read_text("main.py")

        required_keywords = [
            "OUTPUT_DIR",
            "dashboard_data",
            "heatmap",
        ]

        for keyword in required_keywords:
            assert keyword in main_py, f"Missing ETL keyword in main.py: {keyword}"


# ──────────────────────────────────────────────
# GitHub Actions CI/CD
# ──────────────────────────────────────────────

class TestGitHubActionsWorkflow:
    def test_deploy_workflow_exists(self):
        """deploy.yml 應存在。"""
        assert (PROJECT_ROOT / ".github/workflows/deploy.yml").is_file()

    def test_deploy_workflow_contains_docker_build_and_run(self):
        """deploy.yml 應使用 Docker build 與 docker run 執行 ETL。"""
        workflow = read_text(".github/workflows/deploy.yml")

        required_keywords = [
            "docker build",
            "docker run",
            "traffic-etl:ci",
            "Run ETL pipeline in Docker",
        ]

        for keyword in required_keywords:
            assert keyword in workflow, f"Missing workflow keyword: {keyword}"

    def test_deploy_workflow_contains_github_pages_deployment(self):
        """deploy.yml 應包含 GitHub Pages 部署流程。"""
        workflow = read_text(".github/workflows/deploy.yml")

        required_keywords = [
            "actions/configure-pages",
            "actions/upload-pages-artifact",
            "actions/deploy-pages",
            "pages: write",
            "id-token: write",
        ]

        for keyword in required_keywords:
            assert keyword in workflow, f"Missing Pages deployment keyword: {keyword}"

    def test_deploy_workflow_contains_aws_deployment(self):
        """deploy.yml 應包含 AWS S3 + CloudFront 部署流程。"""
        workflow = read_text(".github/workflows/deploy.yml")

        required_keywords = [
            "aws-actions/configure-aws-credentials",
            "aws s3 sync",
            "cloudfront create-invalidation",
            "AWS_OIDC_ROLE_ARN",
            "S3_BUCKET_NAME",
            "CLOUDFRONT_DIST_ID",
        ]

        for keyword in required_keywords:
            assert keyword in workflow, f"Missing AWS deployment keyword: {keyword}"

    def test_deploy_workflow_does_not_use_buildx_cache(self):
        """
        目前 workflow 已改用 docker build，避免 Buildx cache driver 錯誤。
        因此不應再使用 docker/build-push-action 或 buildx cache。
        """
        workflow = read_text(".github/workflows/deploy.yml")

        forbidden_keywords = [
            "docker/setup-buildx-action",
            "docker/build-push-action",
            "cache-from: type=local",
            "cache-to: type=local",
            "/tmp/.buildx-cache",
        ]

        for keyword in forbidden_keywords:
            assert keyword not in workflow, f"Forbidden Buildx keyword found: {keyword}"


# ──────────────────────────────────────────────
# AWS 架構檔案
# ──────────────────────────────────────────────

class TestAWSArchitectureFiles:
    def test_aws_files_exist(self):
        """aws/ 應包含 CloudFormation 與 OIDC 設定文件。"""
        required_files = [
            "aws/cloudformation.yml",
            "aws/iam-oidc-setup.md",
        ]

        for file_path in required_files:
            assert (PROJECT_ROOT / file_path).is_file(), f"Missing {file_path}"

    def test_cloudformation_contains_s3_and_cloudfront(self):
        """CloudFormation 應描述 S3 + CloudFront 架構。"""
        template = read_text("aws/cloudformation.yml")

        required_keywords = [
            "AWS::S3::Bucket",
            "AWS::CloudFront::Distribution",
            "AWS::CloudFront::OriginAccessControl",
            "BucketPolicy",
            "Outputs",
        ]

        for keyword in required_keywords:
            assert keyword in template, f"Missing CloudFormation keyword: {keyword}"

    def test_oidc_setup_doc_contains_github_actions_and_aws_role(self):
        """OIDC 文件應說明 GitHub Actions 與 AWS IAM Role。"""
        doc = read_text("aws/iam-oidc-setup.md")

        required_keywords = [
            "GitHub Actions",
            "OIDC",
            "AWS_OIDC_ROLE_ARN",
            "S3_BUCKET_NAME",
            "CLOUDFRONT_DIST_ID",
            "CLOUDFRONT_DOMAIN",
        ]

        for keyword in required_keywords:
            assert keyword in doc, f"Missing OIDC doc keyword: {keyword}"


# ──────────────────────────────────────────────
# 說明文件品質
# ──────────────────────────────────────────────

class TestDocumentation:
    def test_readme_contains_cloud_project_positioning(self):
        """README 應明確說明此專題是 Docker / AWS / SaaS 專題。"""
        readme = read_text("README.md")

        required_keywords = [
            "Docker",
            "AWS",
            "SaaS",
            "GitHub Actions",
            "CloudFront",
        ]

        for keyword in required_keywords:
            assert keyword in readme, f"Missing README keyword: {keyword}"

    def test_cloud_architecture_doc_exists_if_available(self):
        """
        CLOUD_ARCHITECTURE.md 建議存在。
        如果存在，應包含 Docker、AWS、SaaS、CI/CD 對應說明。
        """
        path = PROJECT_ROOT / "CLOUD_ARCHITECTURE.md"

        assert path.is_file(), "Missing CLOUD_ARCHITECTURE.md"

        doc = path.read_text(encoding="utf-8")

        required_keywords = [
            "Docker",
            "AWS",
            "SaaS",
            "CI/CD",
            "CloudFront",
        ]

        for keyword in required_keywords:
            assert keyword in doc, f"Missing CLOUD_ARCHITECTURE.md keyword: {keyword}"
