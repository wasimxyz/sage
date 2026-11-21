# Reading script for the dictation voice test

Six clips of about two minutes each. Clips 1 to 5 are read from this page. Clip 6 is you talking freely.

## Before you start

1. Run `uv run run.py setup` in `scripts/dictation-spike`. It makes `~/SageDictationSpike` and copies the reference text for clips 1 to 5 into `refs/`.
2. Use the Mac and the mic you'll dictate with.

## How to record

- Open QuickTime Player and choose File > New Audio Recording. In the menu next to the record button, pick the mic, and set quality to Maximum.
- Record one clip per file, and save them as `clip-1` to `clip-6`.
- Convert each recording to WAV, then put the WAV files in `~/SageDictationSpike/clips/`:

  ```
  afconvert -f WAVE -d LEI16@48000 -c 1 clip-1.m4a clip-1.wav
  ```

- If you stumble, keep going. Stumbles are realistic. Afterward, change your copy in `~/SageDictationSpike/refs/` to match what you said.
- Don't read the bracketed directions aloud.

## Clip 1: quiet room, normal journaling

Read at your normal journaling pace in a quiet room. Pause between paragraphs.

> Okay, so it's Sunday evening and I finally have a quiet hour. This week went faster than I expected. Monday and Tuesday were mostly meetings, and by Wednesday I felt like I hadn't actually made anything. That feeling keeps coming back, and I think it's worth paying attention to.
>
> The good part was Thursday. I went for a long walk after lunch, no phone, and somewhere around the second loop of the park the problem I'd been stuck on just sort of untangled itself. It wasn't a clever idea. It was more that I stopped trying to make every piece fit at once.
>
> I also called my sister for the first time in a few weeks. We talked about our parents getting older, which is a conversation neither of us really wants to have, but we both know we need to. She's better at that than I am. I tend to change the subject.
>
> For next week, I want to protect my mornings. No meetings before eleven, if I can manage it. I want to cook at home at least four nights, and I want to get to bed before midnight. Those sound small when I say them out loud, but they're the things that slip first.
>
> Last thing. I've been grateful lately for small routines: coffee on the balcony, the same playlist while I work, writing a few lines here at night. They don't fix anything, but they make the days feel like mine.

## Clip 2: fast, run-on, with fillers

Read quickly, in one breath where you can, the way you talk when you're thinking out loud. Say the fillers.

> So, um, I'm just going to talk because I don't really know what I think yet and that's, that's kind of the point. Today was, uh, it was fine, I guess, but there was this moment in the afternoon where Priya asked me if the plan was still on track and I said yes, like, immediately, and I don't actually know if it's on track, I mean, it might be, but I said yes because saying I don't know felt worse, which is, honestly, which is a pattern. I do that. I say yes and then I scramble to make it true and then I'm tired and I'm annoyed at myself and I'm annoyed at, um, at nobody really. And the thing is, the thing is nobody asked me to be certain. She just asked a question. So why does it, why do I treat every question like a test? I think, okay, I think part of it is I don't like being the person who slows things down, like I'd rather be fast and a bit wrong than slow and right, which sounds good until you're the one cleaning up. Anyway. Tomorrow I'm going to, uh, I'm going to go back to her and say here's where we actually are, here's what I'm not sure about, and here's when I'll know. That's it. That's the whole thing. Um, yeah. I feel a bit better just saying it.

## Clip 3: names, numbers, and dates

Read at a normal pace. You can swap in a few names from your own life. If you do, change `refs/clip-3.txt` to match.

> Notes for the week of November 16th, 2026. On Monday at 9:30 a.m. I have a call with Siobhan Nguyen and Joaquín Alvarez about the Lisbon trip. The flights are $1,284 each, which is about 15% more than in September. We land at 6:45 p.m. on Friday the 4th of December and leave on the 11th.
>
> On Tuesday I need to send the invoice for $3,250 to Kowalski and Sons, reference number 48-B-17. Wednesday is Dr. Okonkwo at 2:15, Suite 304, 1180 Mission Street.
>
> Things to buy: a 27-inch monitor, two packs of AA batteries, and a new charger for the MacBook Pro. Ask Mateo whether the M5 or the M4 Max is worth it for running Ollama with Qwen 3.5 9B.
>
> Reading list: Thich Nhat Hanh, Ursula K. Le Guin, and the essay by Yuval Noah Harari that Aoife sent me. Also look up the walking route near Malvern, about 12 kilometres, and whether the café in Ludlow opens before 8.
>
> Remember: Grandma's 90th birthday is on March 3rd. Rent goes up to $2,150 in January. And call Sean O'Sullivan back before Thursday.

## Clip 4: background noise and typing

Turn on a fan, or a TV or podcast at low volume. Where it says [type], type on the same keyboard for that long, while you keep reading or pause.

> I'm trying something different tonight, talking instead of typing, partly to see if it changes what comes out. [type 3 seconds] When I write, I edit as I go. I delete half a sentence before it's finished. When I talk, the sentence just keeps going, and sometimes it ends up somewhere I didn't plan. [type 3 seconds]
>
> Work today was mostly fine. The new project has more moving parts than anyone admitted at the start, and I think the honest thing is to say that out loud at Friday's review. [type 5 seconds] I'm a little nervous about it, but less than I was this morning.
>
> Outside it's been raining since four. The radiator is clicking and the neighbour's dog has been barking on and off for an hour. [type 3 seconds] Somehow that makes the flat feel smaller and warmer at the same time.
>
> Before bed I want to write down three things that went well. One, I finished the draft. Two, I didn't skip lunch. Three, I answered the email I'd been avoiding for a week. [type 3 seconds] That's enough for today.

## Clip 5: soft voice and long pauses

Read quietly, as if someone is asleep in the next room. At each [pause], stay silent for that long, and leave the room noise as it is. This catches words an engine makes up during silence.

> I'm going to go slowly tonight. [pause 10 seconds] I keep thinking about the conversation with Dad on Sunday. [pause 15 seconds] He said he was proud of me, and I didn't know what to say, so I made a joke. [pause 10 seconds] I wish I'd just said thank you. [pause 20 seconds] Maybe I'll call him tomorrow, not about anything in particular. [pause 10 seconds] Just to talk. [pause 15 seconds] I think that's all I have for tonight. Goodnight.

## Clip 6: free talk

Journal out loud about your day the way you normally would, for about two minutes. Afterward, write down exactly what you said, fillers included, in `~/SageDictationSpike/refs/clip-6.txt`. Listen back as you write, and don't look at either engine's output first. This clip shows how the engines handle real speech, which is harder than reading.
