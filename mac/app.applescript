-- "GIF it Away.app": double-click to open the page, or drop videos on it.
--
-- Deliberately thin. All it does is decide what the user asked for and call the
-- shell scripts next door, which are the same ones a terminal would run. Errors
-- arrive here because `do shell script` raises on a non-zero exit and reports
-- whatever the script wrote to stderr.
--
-- make-app.sh fills in the path below when it compiles this.

property projectRoot : "__PROJECT_ROOT__"

on run
	openThePage()
end run

-- Dropped files, and also "Open With" from the Finder.
on open droppedItems
	if not checkInstall() then return

	set answer to choose from list ¬
		{"Balanced: 800 px wide, 15 fps", ¬
			"Small file: 480 px wide, 10 fps", ¬
			"Best quality: full size, 20 fps", ¬
			"Open the page instead, so I can set it up"} ¬
		with prompt "How should these be converted?" ¬
		with title "GIF it Away" ¬
		default items {"Balanced: 800 px wide, 15 fps"}

	if answer is false then return
	set choice to item 1 of answer

	if choice starts with "Open the page" then
		openThePage()
		return
	end if

	if choice starts with "Small" then
		set theWidth to "480"
		set theFps to "10"
		set theColors to "128"
	else if choice starts with "Best" then
		set theWidth to "0"
		set theFps to "20"
		set theColors to "256"
	else
		set theWidth to "800"
		set theFps to "15"
		set theColors to "256"
	end if

	set failures to {}
	set successes to 0
	set lastReport to ""

	repeat with anItem in droppedItems
		set videoPath to POSIX path of anItem
		set shortName to name of (info for anItem)
		try
			display notification "Converting " & shortName with title "GIF it Away"
			-- A long video can take a while, and the default would give up on it.
			with timeout of 3600 seconds
				set lastReport to (do shell script quoted form of (projectRoot & "/mac/convert-dropped.sh") & ¬
					" " & quoted form of videoPath & " " & theWidth & " " & theFps & " " & theColors)
			end timeout
			set successes to successes + 1
			display notification lastReport with title "GIF it Away"
		on error errorText
			set end of failures to shortName & ": " & errorText
		end try
	end repeat

	if (count of failures) > 0 then
		set joined to ""
		repeat with aFailure in failures
			set joined to joined & aFailure & return
		end repeat
		if successes > 0 then
			display alert "Some of those did not convert" message joined as warning
		else
			display alert "That did not convert" message joined as warning
		end if
	else if successes > 1 then
		display alert "Done" message (successes as text) & " GIFs are saved next to the videos."
	end if
end open

on openThePage()
	if not checkInstall() then return
	try
		with timeout of 120 seconds
			do shell script quoted form of (projectRoot & "/mac/open-page.sh")
		end timeout
	on error errorText
		display alert "Could not open the page" message errorText as warning
	end try
end openThePage

-- The app holds an absolute path, so moving or renaming the project folder
-- breaks it. Say so plainly instead of failing somewhere deeper.
on checkInstall()
	tell application "System Events"
		if not (exists file (projectRoot & "/serve.mjs")) then
			display alert "Cannot find the project" message ¬
				"This app expects it at:" & return & return & projectRoot & return & return & ¬
				"If it moved, run mac/make-app.sh from the new location to rebuild this app." as warning
			return false
		end if
	end tell
	return true
end checkInstall
