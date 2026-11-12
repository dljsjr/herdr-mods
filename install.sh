#!/bin/sh
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
manifest_name=.herdr-mods
manifest_format=1
owner=herdr-mods

usage() {
	cat <<EOF
usage: install.sh install|uninstall|status [--app-home DIR] [--force] [ITEM...]

  install    copy items into the app home; upgrades older installs
  uninstall  remove items this script installed
  status     compare installed items with the repo, changing nothing

  --app-home DIR  default: \$HERDR_APP_HOME, then ~/.config/herdr-app
  --force         replace or remove local edits, and allow downgrades
  ITEM            mods/<name> or layouts/<name>; default: all of them
EOF
}

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 1
}

refuse() {
	printf 'install.sh: %s\n' "$*" >&2
	refused=1
}

hash_lines='s|^\([0-9a-f]*\)  \./|file=\1 |'

# Lines "file=<sha256> <path>" for a folder, skipping dotfiles and the
# files the app writes into every mod folder it loads.
hash_files() {
	(cd "$1" && find . -type f ! -path '*/.*' ! -path ./gpui-kit.d.ts ! -path ./jsconfig.json -exec sha256sum {} +) |
		sed "$hash_lines" | LC_ALL=C sort
}

# Selects an item, mods/<name> or layouts/<name>, and sets its paths: the
# repo source, its VERSION file, the installed target, the installed manifest
# and the staging folder. A layout is one JSON file, so its manifest sits
# beside it under a name the app won't load as a layout.
select_item() {
	item=$1 kind=${1%%/*} name=${1#*/}
	staged=$tmp/stage/$item
	case $kind in
	mods)
		src=$repo/mods/$name
		version_file=$src/VERSION
		target=$app_home/mods/$name
		manifest=$target/$manifest_name
		;;
	layouts)
		src=$repo/layouts/$name.json
		version_file=$repo/layouts/$name.VERSION
		target=$app_home/layouts/$name.json
		manifest=$app_home/layouts/.$name$manifest_name
		;;
	esac
}

# Turns an argument into an item, accepting what shell completion gives:
# mods/<name>/ and layouts/<name>.json.
parse_item() {
	case $1 in
	mods/*) parsed=${1%/} ;;
	layouts/*) parsed=${1%.json} ;;
	*) die "$1 is not mods/<name> or layouts/<name>" ;;
	esac
	case ${parsed#*/} in
	'' | .* | */*) die "no $1 in this repo" ;;
	esac
	if [ "${parsed%%/*}" = mods ]; then
		[ -d "$repo/$parsed" ] || die "no $1 in this repo"
	else
		[ -f "$repo/$parsed.json" ] || die "no $1 in this repo"
	fi
}

is_version() {
	printf '%s\n' "$1" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+'
}

read_repo_version() {
	repo_version=''
	if [ -f "$version_file" ]; then
		read -r repo_version <"$version_file" || :
	fi
	is_version "$repo_version" || die "${version_file#"$repo"/} must hold MAJOR.MINOR.PATCH"
}

read_manifest() {
	m_format='' m_owner='' m_item='' m_version=''
	while IFS= read -r line; do
		case $line in
		format=*) m_format=${line#format=} ;;
		owner=*) m_owner=${line#owner=} ;;
		mod=*) m_item=mods/${line#mod=} ;;
		layout=*) m_item=layouts/${line#layout=} ;;
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

installed_hashes() {
	case $kind in
	mods) hash_files "$target" ;;
	layouts) (cd "$app_home/layouts" && sha256sum "./$name.json") | sed "$hash_lines" ;;
	esac
}

# For the selected item, sets state to absent, foreign, older, same or newer.
# For the last three, edited is set when the installed files no longer match
# the manifest.
classify() {
	read_repo_version
	installed_version='' reason='' edited=''
	if [ ! -e "$target" ]; then
		state=absent
		return
	fi
	state=foreign
	if [ ! -f "$manifest" ]; then
		reason="no $manifest_name manifest"
		return
	fi
	read_manifest "$manifest"
	if [ "$m_format" != "$manifest_format" ]; then
		reason="manifest format $m_format, expected $manifest_format"
	elif [ "$m_owner" != "$owner" ]; then
		reason="owned by $m_owner"
	elif [ "$m_item" != "$item" ]; then
		reason="manifest is for $m_item"
	elif ! is_version "$m_version"; then
		reason="manifest version $m_version is not MAJOR.MINOR.PATCH"
	else
		installed_version=$m_version
		compare_versions "$installed_version" "$repo_version"
		if [ "$(installed_hashes)" != "$(grep '^file=' "$manifest")" ]; then
			edited=1
		fi
	fi
}

# Copies the selected item to its staging folder as it will be installed.
stage() {
	rm -rf "$staged"
	mkdir -p "$staged"
	case $kind in
	mods)
		cp -R "$src/." "$staged"
		rm -f "$staged/VERSION"
		find "$staged" -name '.*' -prune -exec rm -rf {} +
		;;
	layouts) cp "$src" "$staged/$name.json" ;;
	esac
}

# After stage and classify: whether the staged files differ from the installed manifest.
repo_changed() {
	[ "$(hash_files "$staged")" != "$(grep '^file=' "$manifest")" ]
}

check_staged() {
	[ "$kind" = mods ] || return 0
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
		echo "${kind%s}=$name"
		echo "version=$repo_version"
		if [ -n "$commit" ]; then
			echo "commit=$commit"
		fi
		hash_files "$staged"
	} >"$staged/$manifest_name"
}

install_staged() {
	mkdir -p "$app_home/$kind"
	case $kind in
	mods)
		rm -rf "$target"
		cp -R "$staged" "$target"
		;;
	layouts)
		cp "$staged/$manifest_name" "$manifest"
		cp "$staged/$name.json" "$target"
		;;
	esac
}

# Herdr shows a layout only once something switches to it, and it remembers
# the choice in its own state, so a layout installed for the first time is
# switched to once. Upgrades leave the person's choice alone.
switch_to_new() {
	if HERDR_APP_HOME=$app_home herdr-app status >/dev/null 2>&1 &&
		HERDR_APP_HOME=$app_home herdr-app 'do' layout.switch "{\"name\":\"$name\"}" >/dev/null 2>&1; then
		echo "$item: switched the open window to it"
	else
		echo "$item: to show it, open Herdr and run: herdr-app do layout.switch '{\"name\":\"$name\"}'"
	fi
}

# A running window keeps showing a layout after its file is gone, along with
# the mods it uses, so move that window to main first.
switch_away() {
	shown=$(HERDR_APP_HOME=$app_home herdr-app status 2>/dev/null | sed -n 's/^  "layout": "\(.*\)",$/\1/p')
	if [ "$shown" = "$name" ]; then
		HERDR_APP_HOME=$app_home herdr-app 'do' layout.switch '{"name":"main"}' >/dev/null
		echo "$item: switched the open window to layout main"
	fi
}

remove_installed() {
	case $kind in
	mods) rm -rf "$target" ;;
	layouts)
		switch_away
		rm -f "$target" "$manifest"
		;;
	esac
}

# Stages and checks every item first, so a refusal leaves the app home unchanged.
cmd_install() {
	refused=''
	: >"$tmp/plan"
	commit=$(jj -R "$repo" log --no-graph -r @ -T commit_id 2>/dev/null) || commit=''
	for item in $items; do
		select_item "$item"
		classify
		case $state in
		foreign)
			refuse "$item: foreign ($reason); move it aside to install"
			continue
			;;
		newer)
			if [ -z "$force" ]; then
				refuse "$item: installed $installed_version is newer than repo $repo_version; --force downgrades"
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
				refuse "$item: installed files were edited; --force replaces them"
				continue
			fi
			message="$message, replacing local edits"
		fi
		stage
		if [ "$state" = same ] && [ -z "$edited" ]; then
			if ! repo_changed; then
				echo "$item skip up to date $repo_version" >>"$tmp/plan"
				continue
			fi
			message="$message, repo changed without a version bump"
		fi
		if ! check_staged; then
			refuse "$item: herdr-app check failed"
			continue
		fi
		write_manifest
		echo "$item copy $message" >>"$tmp/plan"
	done
	[ -z "$refused" ] || die "nothing was installed"

	while read -r item action message; do
		if [ "$action" = copy ]; then
			select_item "$item"
			install_staged
		fi
		echo "$item: $message"
		case $item/$message in
		layouts/*/installed\ *) switch_to_new ;;
		esac
	done <"$tmp/plan"
}

# Checks every item first, so a refusal leaves the app home unchanged.
cmd_uninstall() {
	refused=''
	: >"$tmp/plan"
	for item in $items; do
		select_item "$item"
		classify
		case $state in
		absent)
			echo "$item skip not installed" >>"$tmp/plan"
			continue
			;;
		foreign)
			refuse "$item: foreign ($reason); not removing it"
			continue
			;;
		esac
		message="uninstalled $installed_version"
		if [ -n "$edited" ]; then
			if [ -z "$force" ]; then
				refuse "$item: installed files were edited; --force removes them"
				continue
			fi
			message="$message, removing local edits"
		fi
		echo "$item remove $message" >>"$tmp/plan"
	done
	[ -z "$refused" ] || die "nothing was uninstalled"

	while read -r item action message; do
		if [ "$action" = remove ]; then
			select_item "$item"
			remove_installed
		fi
		echo "$item: $message"
	done <"$tmp/plan"
}

cmd_status() {
	for item in $items; do
		select_item "$item"
		classify
		case $state in
		absent) echo "$item: absent (repo $repo_version)" ;;
		foreign) echo "$item: foreign ($reason)" ;;
		*)
			notes=''
			if [ -n "$edited" ]; then
				notes=', edited'
			fi
			if [ "$state" = same ]; then
				stage
				if repo_changed; then
					notes="$notes, repo changed without a version bump"
				fi
				echo "$item: same $installed_version$notes"
			else
				echo "$item: $state $installed_version (repo $repo_version)$notes"
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
force=''
mod_items='' layout_items=''
add_item() {
	case $1 in
	mods/*) mod_items="$mod_items $1" ;;
	layouts/*) layout_items="$layout_items $1" ;;
	esac
}
while [ $# -gt 0 ]; do
	case $1 in
	--force) force=1 ;;
	--app-home)
		[ $# -gt 1 ] || die "--app-home needs a folder"
		app_home=$2
		shift
		;;
	-*) die "unknown option: $1" ;;
	*)
		parse_item "$1"
		add_item "$parsed"
		;;
	esac
	shift
done
if [ -z "$mod_items$layout_items" ]; then
	for dir in "$repo"/mods/*/; do
		[ -d "$dir" ] || continue
		dir=${dir%/}
		add_item "mods/${dir##*/}"
	done
	for file in "$repo"/layouts/*.json; do
		[ -f "$file" ] || continue
		file=${file##*/}
		add_item "layouts/${file%.json}"
	done
fi
# Layouts name mods, so mods go in first and come out last.
if [ "$command" = uninstall ]; then
	items="$layout_items $mod_items"
else
	items="$mod_items $layout_items"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for item in $items; do
	select_item "$item"
	read_repo_version
done
[ -d "$app_home" ] || die "no app home at $app_home"

case $command in
install) cmd_install ;;
uninstall) cmd_uninstall ;;
status) cmd_status ;;
esac
