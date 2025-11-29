Allow Change keybinds on onboarding

Add a tutorial for local mode and tell you how to enable it in Onboarding, 

Main menu or onboarding walk you through how to successfully use the app once.

Add a smart mode to the settings and the onboarding, its called smart mode. Smart mode should be at the top of the keybind settings and should be the default enabled. You can tap the keybind to toggle it on and off for recording and transcribing. or hold it down to record and let go to transcribe. 

Please do a few things: check and confirm that the paste feature is working. It seems to randomly stop working. It still transcribes, but it just doesn't paste into the box, which is interesting. So confirm and check all the code on that.


Add a nice tag that can be added to certain models that I mark as suggested. It should be visually distinct


 Allow Change keybinds on onboarding, where it shows the keybinds, allow users to set them there, and also add a spot to onboarding on the keybind screen where they can test by talking into a box


 3. Frontend: Cloud Setup Flow (src/Onboarding.tsx)
New Steps: cloud-auth and cloud-purchase.
NOTE this should have a placeholder spot for CLERK as the auth provider

Flow Update:
Change setup (Cloud selected) to navigate to cloud-auth.
cloud-auth: A placeholder "Sign in / Sign up" screen. Navigates to cloud-purchase on success.
cloud-purchase: A placeholder "Purchase" screen. Navigates to ready on success.
Logic:
Update OnboardingStep type.
Update goToNextStep and goToPrevStep to support the new sequence: setup -> cloud-auth -> cloud-purchase -> ready.
