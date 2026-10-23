<?php
use Illuminate\Support\Facades\Route;
Route::group(['prefix' => 'reviews', 'namespace' => 'Review\Admin'], function () {
    Route::post('approve', 'ReviewController@approve');
});
