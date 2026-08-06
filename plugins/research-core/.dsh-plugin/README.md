# .dsh-plugin — research-core skill pack (static)
#
# Install the methodology skill into any DSH profile via the GitHub
# repository-plugin mechanism (design §4.2 Skills / Domain Packs):
#
#   "dsh.profile.cordis.patch.yml" repository-plugins row:
#     repositories:
#       - github:lzszq/dsh-scholar#main&path:/plugins/research-core/.dsh-plugin
#
# The prepared format supports skills + MCP only; the full code plugin
# (tools + kernel + commands) installs as a bundle:
#   dsh plugin --profile <name> add github:lzszq/dsh-scholar#main
