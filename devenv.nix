{ pkgs, lib, ... }:

{
  packages = [
    pkgs.bun
    pkgs.just
  ];

  git-hooks.hooks.check = {
    enable = true;
    name = "just check";
    entry = "${lib.getExe pkgs.just} check";
    pass_filenames = false;
    always_run = true;
  };
}
