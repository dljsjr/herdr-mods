#!/bin/sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
manifest_name=.herdr-mods
manifest_format=1
owner=herdr-mods

usage() {
	cat <<EOF
usage: install.sh install|uninstall|status [--app-home DIR] [--force] [MOD...]

  install    copy mods into the app home; upgrades older installs
  uninstall  remove mods this script installed
  status     compare installed mods with the repo, changing nothing

  --app-home DIR  default: \$HERDR_APP_HOME, then ~/.config/herdr-app
  --force         replace or remove local edits, and allow downgrades
  MOD             a folder in mods/; default: all of them
EOF
}

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 1
}

# Lines "file=<sha256> <path>" for a mod folder, skipping dotfiles and the
# files the app writes into every mod folder it loads.
hash_files() {
	(cd "$1" && find . -type f ! -path '*/.*' ! -path ./gpui-kit.d.ts ! -path ./jsconfig.json -exec sha256sum {} +) |
		sed 's|^\([0-9a-f]*\)  \./|file=\1 |' | LC_ALL=C sort
}

# Copies a repo mod to $tmp/stage/<mod> as it will be installed.
stage() {
	staged=$tmp/stage/$1
	mkdir -p "$tmp/stage"
	rm -rf "$staged"
	cp -R "$repo/mods/$1" "$staged"
	rm -f "$staged/VERSION"
	find "$staged" -name '.*' -prune -exec rm -rf {} +
}

check_staged() {
	mkdir -p "$tmp/check-home"
	if ! HERDR_APP_HOME=$tmp/check-home HOME=$tmp/check-home herdr-app check "$staged" >"$tmp/check.log" 2>&1; then
		cat "$tmp/check.log" >&2
		return 1
	fi
}

write_manifest() {
	{
		echo "format=$manifest_format"
		echo "owner=$owner"
		echo "mod=$1"
		echo "version=$2"
		if [ -n "$commit" ]; then
			echo "commit=$commit"
		fi
		hash_files "$staged"
	} >"$staged/$manifest_name"
}

read_repo_version() {
	repo_version=''
	if [ -f "$repo/mods/$1/VERSION" ]; then
		read -r repo_version <"$repo/mods/$1/VERSION" || :
	fi
	is_version "$repo_version" || die "$1: mods/$1/VERSION must hold MAJOR.MINOR.PATCH"
}

is_version() {
	printf '%s\n' "$1" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+'
}

read_manifest() {
	m_format='' m_owner='' m_mod='' m_version=''
	while IFS= read -r line; do
		case $line in
		format=*) m_format=${line#format=} ;;
		owner=*) m_owner=${line#owner=} ;;
		mod=*) m_mod=${line#mod=} ;;
		version=*) m_version=${line#version=} ;;
		esac
	done <"$1"
}

# Sets state to older, same or newer: installed version $1 against repo version $2.
compare_versions() {
	a=$1 b=$2
	for _ in 1 2 3; do
		x=${a%%.*} y=${b%%.*}
		if [ "$x" -lt "$y" ]; then
			state=older
			return
		fi
		if [ "$x" -gt "$y" ]; then
			state=newer
			return
		fi
		a=${a#*.} b=${b#*.}
	done
	state=same
}

# Sets state to absent, foreign, older, same or newer. For the last three,
# edited is set when the installed files no longer match the manifest.
classify() {
	read_repo_version "$1"
	target=$app_home/mods/$1
	installed_version='' reason='' edited=''
	if [ ! -e "$target" ]; then
		state=absent
		return
	fi
	state=foreign
	if [ ! -f "$target/$manifest_name" ]; then
		reason="no $manifest_name manifest"
		return
	fi
	read_manifest "$target/$manifest_name"
	if [ "$m_format" != "$manifest_format" ]; then
		reason="manifest format $m_format, expected $manifest_format"
	elif [ "$m_owner" != "$owner" ]; then
		reason="owned by $m_owner"
	elif [ "$m_mod" != "$1" ]; then
		reason="manifest is for $m_mod"
	elif ! is_version "$m_version"; then
		reason="manifest version $m_version is not MAJOR.MINOR.PATCH"
	else
		installed_version=$m_version
		compare_versions "$installed_version" "$repo_version"
		if [ "$(hash_files "$target")" != "$(grep '^file=' "$target/$manifest_name")" ]; then
			edited=1
		fi
	fi
}

# After stage and classify: whether the staged files differ from the installed manifest.
repo_changed() {
	[ "$(hash_files "$staged")" != "$(grep '^file=' "$target/$manifest_name")" ]
}

refuse() {
	printf 'install.sh: %s\n' "$*" >&2
	refused=1
}

# Stages and checks every mod first, so a refusal leaves the app home unchanged.
cmd_install() {
	refused=''
	: >"$tmp/plan"
	commit=$(jj -R "$repo" log --no-graph -r @ -T commit_id 2>/dev/null) || commit=''
	for mod in $mods; do
		classify "$mod"
		case $state in
		foreign)
			refuse "$mod: foreign ($reason); move it aside to install"
			continue
			;;
		newer)
			if [ -z "$force" ]; then
				refuse "$mod: installed $installed_version is newer than repo $repo_version; --force downgrades"
				continue
			fi
			message="downgraded $installed_version -> $repo_version"
			;;
		absent) message="installed $repo_version" ;;
		older) message="upgraded $installed_version -> $repo_version" ;;
		same) message="reinstalled $repo_version" ;;
		esac
		if [ -n "$edited" ]; then
			if [ -z "$force" ]; then
				refuse "$mod: installed files were edited; --force replaces them"
				continue
			fi
			message="$message, replacing local edits"
		fi
		stage "$mod"
		if [ "$state" = same ] && [ -z "$edited" ]; then
			if ! repo_changed; then
				echo "$mod skip up to date $repo_version" >>"$tmp/plan"
				continue
			fi
			message="$message, repo changed without a version bump"
		fi
		if ! check_staged; then
			refuse "$mod: herdr-app check failed"
			continue
		fi
		write_manifest "$mod" "$repo_version"
		echo "$mod copy $message" >>"$tmp/plan"
	done
	[ -z "$refused" ] || die "nothing was installed"

	mkdir -p "$app_home/mods"
	while read -r mod action message; do
		if [ "$action" = copy ]; then
			rm -rf "$app_home/mods/$mod"
			cp -R "$tmp/stage/$mod" "$app_home/mods/$mod"
		fi
		echo "$mod: $message"
	done <"$tmp/plan"
}

# Checks every mod first, so a refusal leaves the app home unchanged.
cmd_uninstall() {
	refused=''
	: >"$tmp/plan"
	for mod in $mods; do
		classify "$mod"
		case $state in
		absent)
			echo "$mod skip not installed" >>"$tmp/plan"
			continue
			;;
		foreign)
			refuse "$mod: foreign ($reason); not removing it"
			continue
			;;
		esac
		message="uninstalled $installed_version"
		if [ -n "$edited" ]; then
			if [ -z "$force" ]; then
				refuse "$mod: installed files were edited; --force removes them"
				continue
			fi
			message="$message, removing local edits"
		fi
		echo "$mod remove $message" >>"$tmp/plan"
	done
	[ -z "$refused" ] || die "nothing was uninstalled"

	while read -r mod action message; do
		if [ "$action" = remove ]; then
			rm -rf "$app_home/mods/$mod"
		fi
		echo "$mod: $message"
	done <"$tmp/plan"
}

cmd_status() {
	for mod in $mods; do
		classify "$mod"
		case $state in
		absent) echo "$mod: absent (repo $repo_version)" ;;
		foreign) echo "$mod: foreign ($reason)" ;;
		*)
			notes=''
			if [ -n "$edited" ]; then
				notes=', edited'
			fi
			if [ "$state" = same ]; then
				stage "$mod"
				if repo_changed; then
					notes="$notes, repo changed without a version bump"
				fi
				echo "$mod: same $installed_version$notes"
			else
				echo "$mod: $state $installed_version (repo $repo_version)$notes"
			fi
			;;
		esac
	done
}

[ $# -gt 0 ] || {
	usage >&2
	exit 2
}
command=$1
shift
case $command in
install | uninstall | status) ;;
*)
	usage >&2
	exit 2
	;;
esac

app_home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
mods=''
force=''
while [ $# -gt 0 ]; do
	case $1 in
	--force) force=1 ;;
	--app-home)
		[ $# -gt 1 ] || die "--app-home needs a folder"
		app_home=$2
		shift
		;;
	-*) die "unknown option: $1" ;;
	*) mods="$mods $1" ;;
	esac
	shift
done

if [ -z "$mods" ]; then
	for dir in "$repo"/mods/*/; do
		[ -d "$dir" ] || continue
		dir=${dir%/}
		mods="$mods ${dir##*/}"
	done
fi
for mod in $mods; do
	case $mod in
	.* | */*) die "no mod named $mod in mods/" ;;
	esac
	[ -d "$repo/mods/$mod" ] || die "no mod named $mod in mods/"
	read_repo_version "$mod"
done
[ -d "$app_home" ] || die "no app home at $app_home"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

case $command in
install) cmd_install ;;
uninstall) cmd_uninstall ;;
status) cmd_status ;;
esac
