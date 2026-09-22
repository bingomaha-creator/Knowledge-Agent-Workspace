import sys
from pathlib import Path

# src 布局：脚本从项目根目录直接运行时，将 src 加入 sys.path 以定位 deepresearch_agent 包
_SRC = Path(__file__).resolve().parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from deepresearch_agent.integrations.build.main import KnowledgeGraphProcessor


def main() -> None:
    processor = KnowledgeGraphProcessor()
    processor.process_all()


if __name__ == "__main__":
    main()
