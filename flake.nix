{
  description = "enboxorg: Decentralized Web Node implemented in TypeScript (Bun monorepo)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Bun runs the workspace; Node is kept for the release scripts that
        # shell out to `npm`, and the Docker CLI is needed by `bun run dev`
        # (the daemon comes from the host).
        tooling = with pkgs; [
          bun
          nodejs
          git
          curl
          docker-client
        ];
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = tooling;

          shellHook = ''
            echo "🥟 Enbox (TypeScript · Bun) development environment"
            echo "bun:  $(bun --version)"
            echo "node: $(node --version)"
            echo ""
            echo "Available commands:"
            echo "  bun install          # install workspace dependencies"
            echo "  bun run build        # turbo build (docs excluded)"
            echo "  bun run dev          # gateway + live-reload DWN server on :3000"
            echo "  bun run dev:ensure   # idempotent start, for agents/CI"
            echo "  bun run test:node    # node test suites"
            echo "  bun run lint         # eslint across packages"
            echo ""
            echo "Note: \`bun run dev\` and the DB-backed suites expect a Docker daemon."
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}
