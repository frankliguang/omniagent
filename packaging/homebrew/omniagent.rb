# OmniAgent Homebrew Formula (M1)
#
# 用法：
#   1. 在你的 GitHub 仓库创建 `homebrew-omniagent` 仓库（如 yourname/homebrew-omniagent）
#   2. 将此文件复制为 Formula/omniagent.rb
#   3. 用户通过以下命令安装：
#      brew tap yourname/omniagent
#      brew install omniagent
#
# 发布新版本时：
#   1. 在 omniagent 主仓库打 tag：`git tag v0.1.0 && git push origin v0.1.0`
#   2. 创建 GitHub Release 并上传编译好的 tarball
#   3. 更新此 formula 的 url 和 sha256

class Omniagent < Formula
  desc "Brand-neutral AI coding assistant (CLI)"
  homepage "https://github.com/omniagent/omniagent"
  url "https://github.com/omniagent/omniagent/releases/download/v0.1.0/omniagent-0.1.0.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  version "0.1.0"

  # Node.js 20+ 运行时（依赖 node formula）
  depends_on "node"

  # OmniAgent 是纯 TypeScript 编译产物，无原生编译
  # macOS arm64 / x86_64 均可运行（解释型）
  # Linux x86_64 也可运行（无 sandbox-exec，bubblewrap 需另装）

  def install
    # 解压后是预编译的 dist/ + package.json + README.md + LICENSE
    # 直接安装 dist/ 到 libexec，bin 软链到 libexec/index.js
    libexec.install Dir["dist"], "package.json", "README.md", "LICENSE"

    # 创建 bin/omniagent 软链到 libexec/dist/index.js
    bin.install_symlink libexec/"dist/index.js" => "omniagent"
  end

  def post_install
    # 创建 ~/.omniagent 目录结构
    home = ENV["HOME"] || Dir.home
    %w[.omniagent .omniagent/memory .omniagent/logs .omniagent/transcripts].each do |d|
      mkdir_p File.join(home, d)
    end

    # 提示用户配置 LLM provider
    opoo <<~EOS
      OmniAgent installed successfully!

      To use it, set your LLM provider credentials:
        export OMNIAGENT_LLM_PROVIDER=openai
        export OMNIAGENT_LLM_API_KEY=sk-...

      Or for AWS Bedrock:
        export AWS_ACCESS_KEY_ID=...
        export AWS_SECRET_ACCESS_KEY=...

      Then run:
        omniagent -p "list files in current directory"

      For more info: https://github.com/omniagent/omniagent
    EOS
  end

  test do
    # 验证 --version 正常输出
    assert_match(/^#{version}/, shell_output("#{bin}/omniagent --version"))
    # 验证 --help 不报错
    assert_match(/Usage:|用法/, shell_output("#{bin}/omniagent --help"))
  end
end
