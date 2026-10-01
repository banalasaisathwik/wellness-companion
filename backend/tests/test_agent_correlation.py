from types import SimpleNamespace

from src.agent import find_speech_owner


def test_assistant_item_uses_owning_speech_handle() -> None:
    old_item = SimpleNamespace(id="item-old")
    new_item = SimpleNamespace(id="item-new")
    handles = {
        "speech-old": SimpleNamespace(chat_items=[old_item]),
        "speech-new": SimpleNamespace(chat_items=[new_item]),
    }

    assert find_speech_owner(old_item, handles) == "speech-old"
    assert find_speech_owner(new_item, handles) == "speech-new"
    assert find_speech_owner(SimpleNamespace(id="item-old"), handles) is None
